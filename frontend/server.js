const express = require('express');
const app = express();
const cors = require('cors');
const https = require('https');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const { createProxyMiddleware } = require('http-proxy-middleware');
const serverCfg = require('./config/server-mode.node.js');
const { getCurrentServerConfig, printConfig, getLocalIP, BACKEND_SERVER_URL, PRIORITIZE_BACKEND_SERVER } = serverCfg;

const currentConfig = getCurrentServerConfig();
const port = currentConfig.port; // 来自环境变量 PORT，默认 8080，部署到 Render 时由平台注入

// ==================== WebSocket 支持 ====================
// 尝试加载 ws 模块（如果未安装需要运行: npm install ws）
let WebSocketServer;
try {
	const ws = require('ws');
	WebSocketServer = ws.WebSocketServer;
} catch (error) {
	console.warn('⚠️  WebSocket 模块未安装，实时通信功能将不可用。请运行: npm install ws');
	WebSocketServer = null;
}

// WebSocket 客户端连接池
const wsClients = new Set();

// 创建 HTTP 服务器（用于支持 WebSocket）
const server = http.createServer(app);
let wss = null;

if (WebSocketServer) {
	wss = new WebSocketServer({ server, path: '/ws' });
	
	wss.on('connection', (ws, req) => {
		console.log('✅ WebSocket 客户端已连接:', req.socket.remoteAddress);
		wsClients.add(ws);
		
		// 发送欢迎消息和当前状态
		ws.send(JSON.stringify({
			type: 'connected',
			message: '已连接到实时数据服务'
		}));
		
		// 发送当前状态
		broadcastCurrentState(ws);
		
		ws.on('message', (message) => {
			try {
				const data = JSON.parse(message);
				handleWebSocketMessage(ws, data);
			} catch (error) {
				console.error('WebSocket 消息解析失败:', error);
			}
		});
		
		ws.on('close', () => {
			console.log('❌ WebSocket 客户端已断开');
			wsClients.delete(ws);
		});
		
		ws.on('error', (error) => {
			console.error('WebSocket 错误:', error);
			wsClients.delete(ws);
		});
	});
}

// WebSocket 消息处理
function handleWebSocketMessage(ws, data) {
	switch (data.type) {
		case 'ping':
			ws.send(JSON.stringify({ type: 'pong' }));
			break;
		case 'control-live':
			// 后台管理系统控制直播状态
			handleLiveControl(data);
			break;
		case 'update-debate':
			// 后台管理系统更新辩论设置
			handleDebateUpdate(data);
			break;
		default:
			console.log('未知的 WebSocket 消息类型:', data.type);
	}
}

// 广播消息给所有客户端
function broadcast(type, data) {
	if (!wss || wsClients.size === 0) return;
	
	const message = JSON.stringify({ type, data, timestamp: Date.now() });
	
	// 移除已关闭的连接
	wsClients.forEach(client => {
		if (client.readyState === 1) { // WebSocket.OPEN
			client.send(message);
		} else {
			wsClients.delete(client);
		}
	});
}

// 广播当前状态（用于新连接）；直播中投票数据用本场票数，与大屏一致、不受当前票数影响
function broadcastCurrentState(ws) {
	if (!ws || ws.readyState !== 1) return;
	
	try {
		const db = require(ADMIN_DB_PATH);
		const dashboard = db.statistics.getDashboard();
		const debate = db.debate.get();
		const sid = (globalLiveStatus && globalLiveStatus.streamId) ? globalLiveStatus.streamId : (db.streams.getActive() ? db.streams.getActive().id : null);
		const streamStatus = sid ? (streamLiveStatuses[sid] || { isLive: false }) : { isLive: false };
		const v = sid ? (streamStatus.isLive ? getLiveSessionVotes(sid) : getVotesState(sid)) : { leftVotes: 0, rightVotes: 0 };
		
		ws.send(JSON.stringify({
			type: 'state',
			data: {
				votes: {
					...v,
					streamId: sid,
					totalVotes: (v.leftVotes || 0) + (v.rightVotes || 0),
					allTotalVotes: getAllVotesTotal()
				},
				debate: debate,
				dashboard: dashboard,
				liveStatus: dashboard.isLive
			},
			timestamp: Date.now()
		}));
	} catch (error) {
		console.error('发送当前状态失败:', error);
	}
}

// 处理直播控制
function handleLiveControl(data) {
	try {
		const db = require(ADMIN_DB_PATH);
		const { action } = data; // 'start' 或 'stop'
		
		if (action === 'start') {
			// 开启直播
			const activeStream = db.streams.getActive();
			if (activeStream) {
				broadcast('live-status-changed', {
					status: 'started',
					streamUrl: activeStream.url,
					timestamp: Date.now()
				});
			}
		} else if (action === 'stop') {
			// 停止直播
			broadcast('live-status-changed', {
				status: 'stopped',
				timestamp: Date.now()
			});
		}
	} catch (error) {
		console.error('处理直播控制失败:', error);
	}
}

// 处理辩论设置更新
function handleDebateUpdate(data) {
	// 这个功能已经通过 REST API 实现了，这里可以添加额外的实时通知
	broadcast('debate-updated', {
		debate: data.debate,
		timestamp: Date.now()
	});
}

// CORS 配置 - 允许所有来源（开发环境）
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
    exposedHeaders: ['Content-Length', 'Content-Type'],
    credentials: true,
    maxAge: 86400 // 24小时预检请求缓存
}));

// 处理 OPTIONS 预检请求
app.options('*', (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin');
    res.header('Access-Control-Max-Age', '86400');
    res.sendStatus(204);
});

// 增大 JSON 请求体限制，支持 base64 头像上传（默认 100kb 不足）
app.use(express.json({ limit: '10mb' }));

// ==================== 后台管理路由（必须在代理之前） ====================
const path = require('path');
const ADMIN_DIR = path.join(__dirname, '..', 'frontend', 'admin');
const ADMIN_DB_PATH = path.join(ADMIN_DIR, 'db.js');

// 根路径重定向到后台管理
app.get('/', (req, res) => {
	res.redirect(302, '/admin');
});

app.get('/admin', (req, res) => {
	res.sendFile(path.join(ADMIN_DIR, 'index.html'));
});

// 提供后台管理静态资源
app.use('/admin', express.static(ADMIN_DIR));

app.use('/static', express.static(path.join(__dirname, '..', 'frontend', 'static')));
// 缺失的 iconfont 字体：返回 204，避免控制台 404（实际字体文件未放入仓库时）
app.get('/static/iconfont/iconfont.woff2', (req, res) => { res.status(204).end(); });
app.get('/static/iconfont/iconfont.woff', (req, res) => { res.status(204).end(); });
app.get('/static/iconfont/iconfont.ttf', (req, res) => { res.status(204).end(); });
// ==================== 后台管理路由结束 ====================

// ==================== 直播流管理 API（优先于代理，确保添加后列表立即可见） ====================
// 无论是否启用后端代理，直播流增删改查都走本地 db（data/streams.json），避免保存后列表不刷新
const db = require(ADMIN_DB_PATH);

function streamsListHandler(req, res) {
	try {
		const streams = db.streams.getAll();
		const list = streams.map(stream => {
			const st = streamLiveStatuses[stream.id] || { isLive: false };
			// 未直播时在线人数、观看人数显示 0；直播中取实时值
			const online = st.isLive ? (streamOnlineCounts[stream.id] || 0) : 0;
			const viewers = st.isLive ? (streamViewers[stream.id] ?? db.streamViewersDb.get(stream.id)) : 0;
			const vCur = getVotesState(stream.id);
			// 直播中卡片展示本场票数（与大屏一致），未直播展示当前票数（关播后已归零）
			const vDisplay = st.isLive ? getLiveSessionVotes(stream.id) : vCur;
			return {
				...stream,
				playUrls: { hls: stream.url, flv: null, rtmp: null },
				liveStatus: {
					isLive: !!st.isLive,
					liveId: st.liveId || null,
					startTime: st.startTime || null,
					stopTime: st.stopTime || null,
					streamUrl: st.streamUrl || stream.url
				},
				streamOnlineUsers: online,
				streamViewersCount: viewers,
				leftVotes: vDisplay.leftVotes || 0,
				rightVotes: vDisplay.rightVotes || 0,
				// 票数管理用：当前票数（可手动修改）
				currentLeftVotes: vCur.leftVotes || 0,
				currentRightVotes: vCur.rightVotes || 0
			};
		});
		res.json({
			success: true,
			data: { streams: list, total: list.length },
			timestamp: Date.now()
		});
	} catch (error) {
		console.error('获取直播流列表失败:', error);
		res.status(500).json({ success: false, message: '获取直播流列表失败: ' + error.message });
	}
}

function streamsPostHandler(req, res) {
	try {
		const { name, url, type, description, enabled } = req.body;
		if (!name || !url || !type) {
			return res.status(400).json({ success: false, message: '缺少必要参数: name, url, type 必填' });
		}
		try { new URL(url); } catch (e) {
			return res.status(400).json({ success: false, message: '流地址格式不正确' });
		}
		if (!['hls', 'rtmp', 'flv'].includes(type)) {
			return res.status(400).json({ success: false, message: 'type 必须是 hls, rtmp 或 flv' });
		}
		const newStream = {
			id: `stream-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
			name: name.trim(),
			url: url.trim(),
			type,
			description: description ? description.trim() : '',
			enabled: enabled !== false,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString()
		};
		db.streams.add(newStream);
		console.log('✅ 新增直播流:', newStream.name, newStream.url);
		res.json({ success: true, data: newStream, message: '直播流添加成功', timestamp: Date.now() });
	} catch (error) {
		console.error('添加直播流失败:', error);
		res.status(500).json({ success: false, message: '添加直播流失败: ' + error.message });
	}
}

function streamsPutHandler(req, res) {
	try {
		const streamId = req.params.id;
		const { name, url, type, description, enabled } = req.body;
		const stream = db.streams.getById(streamId);
		if (!stream) return res.status(404).json({ success: false, message: '直播流不存在' });
		if (url) { try { new URL(url); } catch (e) { return res.status(400).json({ success: false, message: '流地址格式不正确' }); } }
		if (type && !['hls', 'rtmp', 'flv'].includes(type)) return res.status(400).json({ success: false, message: 'type 必须是 hls, rtmp 或 flv' });
		const updates = {};
		if (name !== undefined) updates.name = name.trim();
		if (url !== undefined) updates.url = url.trim();
		if (type !== undefined) updates.type = type;
		if (description !== undefined) updates.description = description.trim();
		if (enabled !== undefined) updates.enabled = enabled;
		updates.updatedAt = new Date().toISOString();
		const updated = db.streams.update(streamId, updates);
		res.json({ success: true, data: updated, message: '直播流更新成功', timestamp: Date.now() });
	} catch (error) {
		console.error('更新直播流失败:', error);
		res.status(500).json({ success: false, message: '更新直播流失败: ' + error.message });
	}
}

function streamsDeleteHandler(req, res) {
	try {
		const streamId = req.params.id;
		const stream = db.streams.getById(streamId);
		if (!stream) return res.status(404).json({ success: false, message: '直播流不存在' });
		db.streams.delete(streamId);
		console.log('✅ 删除直播流:', streamId, stream.name);
		res.json({ success: true, data: { id: streamId, name: stream.name }, message: '直播流删除成功', timestamp: Date.now() });
	} catch (error) {
		console.error('删除直播流失败:', error);
		res.status(500).json({ success: false, message: '删除直播流失败: ' + error.message });
	}
}

app.get('/api/v1/admin/streams', streamsListHandler);
app.get('/api/admin/streams', streamsListHandler);
app.post('/api/v1/admin/streams', streamsPostHandler);
app.post('/api/admin/streams', streamsPostHandler);
app.put('/api/v1/admin/streams/:id', streamsPutHandler);
app.put('/api/admin/streams/:id', streamsPutHandler);
app.delete('/api/v1/admin/streams/:id', streamsDeleteHandler);
app.delete('/api/admin/streams/:id', streamsDeleteHandler);
app.post('/api/v1/admin/streams/:id/toggle', (req, res) => {
	try {
		const updated = db.streams.toggle(req.params.id);
		if (!updated) return res.status(404).json({ success: false, message: '直播流不存在' });
		res.json({ success: true, data: updated, message: '状态已切换', timestamp: Date.now() });
	} catch (e) {
		res.status(500).json({ success: false, message: e.message });
	}
});
app.post('/api/admin/streams/:id/toggle', (req, res) => {
	try {
		const updated = db.streams.toggle(req.params.id);
		if (!updated) return res.status(404).json({ success: false, message: '直播流不存在' });
		res.json({ success: true, data: updated, message: '状态已切换', timestamp: Date.now() });
	} catch (e) {
		res.status(500).json({ success: false, message: e.message });
	}
});

// 直播流辩题（本地存储，修改后列表立即可见）
app.get('/api/v1/admin/streams/:id/debate', (req, res) => {
	try {
		const debate = db.streamDebates.get(req.params.id);
		res.json(debate ? { success: true, data: debate } : { success: true, data: null });
	} catch (e) {
		res.status(500).json({ success: false, message: e.message });
	}
});
app.put('/api/v1/admin/streams/:id/debate', (req, res) => {
	try {
		const { title, description, leftPosition, rightPosition, isActive } = req.body;
		const saved = db.streamDebates.set(req.params.id, {
			title: title || '',
			description: description || '',
			leftPosition: leftPosition || '',
			rightPosition: rightPosition || '',
			isActive: !!isActive
		});
		res.json({ success: true, data: saved });
	} catch (e) {
		res.status(500).json({ success: false, message: e.message });
	}
});
app.delete('/api/v1/admin/streams/:id/debate', (req, res) => {
	try {
		db.streamDebates.remove(req.params.id);
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ success: false, message: e.message });
	}
});

// 辩论流程（环节）管理 - 数据大屏接口
app.get('/api/admin/debate-flow', (req, res) => {
	try {
		const streamId = req.query.stream_id;
		if (!streamId) {
			return res.status(400).json({ success: false, error: '缺少 stream_id 参数' });
		}
		const flow = db.debateFlows.get(streamId);
		res.json({ success: true, ...flow });
	} catch (e) {
		console.error('获取辩论流程失败:', e);
		res.status(500).json({ success: false, error: e.message });
	}
});
app.post('/api/admin/debate-flow', (req, res) => {
	try {
		const { stream_id: streamId, segments } = req.body;
		if (!streamId) {
			return res.status(400).json({ success: false, error: '缺少 stream_id 参数' });
		}
		if (!Array.isArray(segments)) {
			return res.status(400).json({ success: false, error: 'segments 必须为数组' });
		}
		const validSegments = segments.map(s => ({
			name: String(s.name || '').trim() || '未命名环节',
			duration: Math.max(10, parseInt(s.duration, 10) || 180),
			side: ['left', 'right', 'both'].includes(s.side) ? s.side : 'both'
		}));
		db.debateFlows.set(streamId, validSegments);
		broadcast('debate-flow-updated', {
			streamId,
			flow: validSegments,
			timestamp: Date.now()
		});
		res.json({ success: true, segments: validSegments });
	} catch (e) {
		console.error('保存辩论流程失败:', e);
		res.status(500).json({ success: false, error: e.message });
	}
});
app.post('/api/admin/debate-flow/control', (req, res) => {
	try {
		const { stream_id: streamId, action } = req.body;
		if (!streamId || !action) {
			return res.status(400).json({ success: false, error: '缺少 stream_id 或 action 参数' });
		}
		const validActions = ['start', 'pause', 'resume', 'reset', 'next', 'prev'];
		if (!validActions.includes(action)) {
			return res.status(400).json({ success: false, error: 'action 必须是: ' + validActions.join(', ') });
		}
		broadcast('debate-flow-control', {
			streamId,
			action,
			timestamp: Date.now()
		});
		res.json({ success: true, action });
	} catch (e) {
		console.error('发送流程控制命令失败:', e);
		res.status(500).json({ success: false, error: e.message });
	}
});

// 评委管理 API
app.get('/api/admin/judges', (req, res) => {
	try {
		const streamId = req.query.stream_id;
		if (!streamId) {
			return res.status(400).json({ success: false, error: '缺少 stream_id 参数' });
		}
		const cfg = db.judges.get(streamId);
		res.json({ success: true, data: cfg });
	} catch (e) {
		console.error('获取评委配置失败:', e);
		res.status(500).json({ success: false, error: e.message });
	}
});
app.post('/api/admin/judges', (req, res) => {
	try {
		const { stream_id: streamId, judges: judgesList, replaced_user_ids: replacedUserIds } = req.body;
		if (!streamId) {
			return res.status(400).json({ success: false, error: '缺少 stream_id 参数' });
		}
		if (!Array.isArray(judgesList) || judgesList.length === 0) {
			return res.status(400).json({ success: false, error: 'judges 必须为非空数组' });
		}
		// 将被替换的评委用户设为 banned（不能看直播、不能投票；评委被选用时可看可投，只有被替换后才禁用）
		const toBan = replacedUserIds || [];
		for (const userId of toBan) {
			try {
				const user = db.users.getById(userId);
				if (user) {
					db.users.setStatus(userId, 'banned');
					console.log('✅ 被替换评委已禁用:', userId);
				}
			} catch (err) {
				console.warn('禁用用户失败:', userId, err);
			}
		}
		const validJudges = judgesList.slice(0, 3).map((j, i) => ({
			id: j.id || `judge-${i + 1}`,
			name: String(j.name || '').trim() || `评委${i + 1}`,
			role: String(j.role || '').trim() || '评委',
			avatar: j.avatar || '/admin/assets/images/judges/osmanthus.jpg',
			votes: Math.max(0, parseInt(j.votes, 10) || 10),
			userId: j.userId || null
		}));
		db.judges.set(streamId, validJudges, toBan);
		broadcast('judges-updated', { streamId, judges: validJudges, timestamp: Date.now() });
		res.json({ success: true, data: { judges: validJudges } });
	} catch (e) {
		console.error('保存评委配置失败:', e);
		res.status(500).json({ success: false, error: e.message });
	}
});

// 头像上传 API（base64）
app.post('/api/admin/upload/avatar', (req, res) => {
	try {
		const { base64 } = req.body;
		if (!base64 || typeof base64 !== 'string') {
			return res.status(400).json({ success: false, error: '缺少 base64 参数' });
		}
		const match = base64.match(/^data:image\/(\w+);base64,(.+)$/);
		if (!match) {
			return res.status(400).json({ success: false, error: 'base64 格式不正确' });
		}
		const ext = match[1] === 'jpeg' || match[1] === 'jpg' ? 'jpg' : match[1] === 'png' ? 'png' : 'jpg';
		const buf = Buffer.from(match[2], 'base64');
		const dir = path.join(ADMIN_DIR, 'assets', 'images', 'judges');
		if (!require('fs').existsSync(dir)) {
			require('fs').mkdirSync(dir, { recursive: true });
		}
		const filename = `judge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
		const filepath = path.join(dir, filename);
		require('fs').writeFileSync(filepath, buf);
		const url = `/admin/assets/images/judges/${filename}`;
		res.json({ success: true, url });
	} catch (e) {
		console.error('头像上传失败:', e);
		res.status(500).json({ success: false, error: e.message });
	}
});

// 用户列表与开播时 mock 用户（本地 db，优先于代理）
function usersListHandler(req, res) {
	try {
		const list = db.users.getAll();
		res.json({ success: true, data: { users: list }, total: list.length });
	} catch (e) {
		res.status(500).json({ success: false, message: e.message });
	}
}
app.get('/api/v1/admin/users', usersListHandler);
app.get('/api/admin/users', usersListHandler);

// 评委选择用：返回所有用户（含 banned、judge_only），供“从用户选择”使用
app.get('/api/admin/users/for-judge-select', (req, res) => {
	try {
		const list = db.users.getAll();
		res.json({ success: true, data: { users: list }, total: list.length });
	} catch (e) {
		res.status(500).json({ success: false, message: e.message });
	}
});

// 禁用/解禁用户（禁用后不能观看/投票）
app.post('/api/v1/admin/users/:id/toggle-ban', (req, res) => {
	try {
		const userId = req.params.id;
		const user = db.users.getById(userId);
		if (!user) return res.status(404).json({ success: false, message: '用户不存在' });
		const nextStatus = user.status === 'banned' ? 'offline' : 'banned';
		const updated = db.users.setStatus(userId, nextStatus);
		res.json({ success: true, data: updated, message: nextStatus === 'banned' ? '已禁用' : '已解除禁用' });
	} catch (e) {
		res.status(500).json({ success: false, message: e.message });
	}
});

// 获取用户投票历史（用于“历史投票次数”详情）
app.get('/api/v1/admin/users/:id/votes', (req, res) => {
	try {
		const userId = req.params.id;
		const history = db.users.getVoteHistory(userId);
		res.json({ success: true, data: { userId, total: history.length, items: history } });
	} catch (e) {
		res.status(500).json({ success: false, message: e.message });
	}
});

app.get('/api/v1/admin/streams/:streamId/voters', (req, res) => {
	try {
		const streamId = req.params.streamId;
		const users = db.users.getAll();
		const voters = [];
		users.forEach(u => {
			const history = Array.isArray(u.voteHistory) ? u.voteHistory : [];
			history.forEach(rec => {
				if (String(rec.streamId) === String(streamId)) {
					voters.push({
						userId: u.id,
						nickName: u.nickName || u.id,
						side: rec.side,
						votes: rec.votes,
						at: rec.at
					});
				}
			});
		});
		voters.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
		res.json({ success: true, data: { streamId, voters } });
	} catch (e) {
		res.status(500).json({ success: false, message: e.message });
	}
});

app.post('/api/v1/admin/live/seed-mock-users', (req, res) => {
	try {
		const existing = db.users.getAll();
		const targetCount = 38;  // 38 个 mock 用户（评委3 + 观众35），与数据概览一致
		const defaultAvatar = '/static/iconfont/wode.png';
		const toAdd = Math.max(0, targetCount - existing.length);
		for (let i = 0; i < toAdd; i++) {
			const id = `mock-user-${Date.now()}-${i}`;
			db.users.createOrUpdate({
				id,
				nickName: `观众${i + 1}`,
				avatarUrl: defaultAvatar,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				totalVotes: 0,
				joinedDebates: 0,
				status: 'active'
			});
		}
		const total = db.users.getAll().length;
		console.log('✅ 已注入 mock 用户，当前用户数:', total);
		res.json({ success: true, data: { count: total }, message: toAdd > 0 ? `已生成 ${toAdd} 个 mock 用户` : '已有 38 个用户' });
	} catch (e) {
		console.error('seed-mock-users 失败:', e);
		res.status(500).json({ success: false, message: e.message });
	}
});

// Mock 投票会话（按流按场次：每场直播每人一次机会，开播时清空该流）
const mockVoteSessions = new Map(); // streamId -> Set<userId>

// 同步 Mock 直播状态（数据概览页「开始/停止直播」时调用，评委在线、票数保留不归零）
app.post('/api/v1/admin/sync-mock-live-state', (req, res) => {
	try {
		const { streamIds = [] } = req.body;
		const newIds = new Set(Array.isArray(streamIds) ? streamIds : []);
		// 停止的流：本场正反方票数返给票数分析（累加）和当前票数（写入），再初始化本场
		const dbMock = require(ADMIN_DB_PATH);
		mockLiveStreamIds.forEach(id => {
			if (!newIds.has(id)) {
				const sessionV = getLiveSessionVotes(id);
				let sessionLeft = sessionV.leftVotes || 0;
				let sessionRight = sessionV.rightVotes || 0;
				if (sessionLeft === 0 && sessionRight === 0) {
					const cur = getVotesState(id);
					sessionLeft = cur.leftVotes || 0;
					sessionRight = cur.rightVotes || 0;
				}
				accumulateStreamVotesIntoDaily(id, sessionLeft, sessionRight);
				initLiveSessionVotesForStream(id);
				setVotesState(id, sessionLeft, sessionRight);
				try { dbMock.votes.set(id, sessionLeft, sessionRight); } catch (e) { /* ignore */ }
				streamViewers[id] = 0;
				try { dbMock.streamViewersDb.set(id, 0); } catch (e) { /* ignore */ }
				mockVoteSessions.delete(id);
				streamOnlineCounts[id] = 0;
				streamOnlineUserIds[id] = new Set();
			}
		});
		// 新开播的流：清空该流 mock 投票会话（本场可再投），初始化本场票数（大屏用）、在线/观看
		newIds.forEach(streamId => {
			if (!mockLiveStreamIds.has(streamId)) mockVoteSessions.delete(streamId); // 本场直播每人一次机会
			// 本场票数：mock 开播时也初始化，大屏才能获取本场直播的票
			initLiveSessionVotesForStream(streamId);
			if (!streamOnlineCounts.hasOwnProperty(streamId) || streamOnlineCounts[streamId] === undefined) {
				streamOnlineCounts[streamId] = 0; // 单流在线从 0 开始，由波动定时器每 8-12s ±1-2 增长
				refreshStreamOnlineUserIds(streamId);
			}
			streamViewers[streamId] = streamViewers[streamId] ?? require(ADMIN_DB_PATH).streamViewersDb.get(streamId);
		});
		const stoppedIds = Array.from(mockLiveStreamIds).filter(id => !newIds.has(id));
		mockLiveStreamIds = newIds;
		console.log('📡 Mock 直播状态已同步:', Array.from(mockLiveStreamIds));
		// 广播关播与返给后的票数，让前端刷新投票分析图
		stoppedIds.forEach(id => {
			broadcast('live-status-changed', { streamId: id, status: 'stopped', timestamp: Date.now() });
			const v = getVotesState(id);
			const total = (v.leftVotes || 0) + (v.rightVotes || 0);
			broadcast('votes-updated', {
				streamId: id,
				leftVotes: v.leftVotes || 0,
				rightVotes: v.rightVotes || 0,
				totalVotes: total,
				source: 'mock-live-end',
				timestamp: new Date().toISOString()
			});
		});
		res.json({ success: true, data: { streamIds: Array.from(mockLiveStreamIds) } });
	} catch (e) {
		res.status(500).json({ success: false, message: e.message });
	}
});

// Mock 记录单次投票（数据概览页/动态模拟调用，绑定到具体用户或评委）
// 规则：普通用户 1 次投票 = 2 票全投同一阵营；评委 1 次投票 = 10 票（或评委页设置），历史投票次数 +1
app.post('/api/v1/admin/mock-record-vote', (req, res) => {
	try {
		const { streamId, userId, side, isJudge } = req.body;
		if (!streamId || !userId || (side !== 'left' && side !== 'right')) {
			return res.status(400).json({ success: false, message: 'streamId、userId、side 必填，side 为 left 或 right' });
		}
		const dbLocal = require(ADMIN_DB_PATH);
		const u = dbLocal.users.getById(userId);
		if (!u) return res.status(404).json({ success: false, message: '用户不存在' });
		if (u.status === 'banned') return res.status(403).json({ success: false, message: '用户已禁用' });
		if (!mockVoteSessions.has(streamId)) mockVoteSessions.set(streamId, new Set());
		const sess = mockVoteSessions.get(streamId);
		if (sess.has(userId)) return res.status(409).json({ success: false, message: '该用户在本场直播已投过票（每场一次机会）' });
		sess.add(userId);
		// 评委：按评委页设置或默认 10 票；否则按传入 isJudge；否则查该流评委配置判断是否评委
		let voteCount = 2;
		if (isJudge === true) {
			voteCount = 10;
		} else {
			const judgeCfg = dbLocal.judges.get ? dbLocal.judges.get(streamId) : null;
			const judgeList = (judgeCfg && Array.isArray(judgeCfg.judges)) ? judgeCfg.judges : [];
			const judgeForUser = judgeList.find(j => (j.userId || (j.id === 'judge-1' ? 'judge-user-1' : j.id === 'judge-2' ? 'judge-user-2' : j.id === 'judge-3' ? 'judge-user-3' : null)) === userId);
			if (judgeForUser) {
				voteCount = Math.max(0, parseInt(judgeForUser.votes, 10) || 10);
			} else {
				voteCount = 2;
			}
		}
		if (side === 'left') {
			addVotesState(streamId, voteCount, 0);
			addLiveSessionVotes(streamId, voteCount, 0);
		} else {
			addVotesState(streamId, 0, voteCount);
			addLiveSessionVotes(streamId, 0, voteCount);
		}
		dbLocal.users.appendVoteRecord(userId, { streamId, liveId: 'mock', side, votes: voteCount, at: new Date().toISOString() });
		dbLocal.statistics.incrementVotes(voteCount);
		const v = getVotesState(streamId);
		const total = (v.leftVotes || 0) + (v.rightVotes || 0);
		const statsNow = dbLocal.statistics.get();
		const mockPayload = { streamId, leftVotes: v.leftVotes, rightVotes: v.rightVotes, totalVotes: total, allTotalVotes: getAllVotesTotal(), globalTotalVotes: (statsNow && statsNow.totalVotes != null) ? statsNow.totalVotes : getAllVotesTotal(), source: 'mock', timestamp: new Date().toISOString() };
		const stMock = streamLiveStatuses[streamId];
		if (stMock && stMock.isLive) {
			const sessionV = getLiveSessionVotes(streamId);
			mockPayload.liveSessionLeft = sessionV.leftVotes;
			mockPayload.liveSessionRight = sessionV.rightVotes;
		}
		broadcast('votes-updated', mockPayload);
		res.json({ success: true, data: { leftVotes: v.leftVotes, rightVotes: v.rightVotes, totalVotes: total } });
	} catch (e) {
		console.error('mock-record-vote 失败:', e);
		res.status(500).json({ success: false, message: e.message });
	}
});

// 数据概览本地 mock：总用户数、总投票数、在线用户（不依赖真实开播）
function ensureMockUsers35() {
	const existing = db.users.getAll();
	if (existing.length >= 35) return;
	const targetCount = 35;
	const defaultAvatar = '/static/iconfont/wode.png';
	const toAdd = targetCount - existing.length;
	for (let i = 0; i < toAdd; i++) {
		const id = `mock-user-${Date.now()}-${i}`;
		db.users.createOrUpdate({
			id,
			nickName: `观众${existing.length + i + 1}`,
			avatarUrl: defaultAvatar,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			totalVotes: 0,
			joinedDebates: 0,
			status: 'active'
		});
	}
}
function getDashboardMock(req, res) {
	try {
		ensureMockUsers35();
		const allUsers = db.users.getAll();
		const totalUsers = allUsers.length;

		// 直播开始时评委一定在线；禁用用户不参与在线/离线
		const eligible = allUsers.filter(u => u.status !== 'banned');
		const anyLive = Object.values(streamLiveStatuses).some(s => s && s.isLive) || mockLiveStreamIds.size > 0;
		const judgeUserIds = new Set();
		if (anyLive) {
			// 真实直播流
			for (const [streamId, st] of Object.entries(streamLiveStatuses)) {
				if (st && st.isLive) {
					const cfg = db.judges.get(streamId);
					(cfg.judges || []).forEach(j => {
						const uid = j.userId || (j.id === 'judge-1' ? 'judge-user-1' : j.id === 'judge-2' ? 'judge-user-2' : j.id === 'judge-3' ? 'judge-user-3' : null);
						if (uid) judgeUserIds.add(uid);
					});
				}
			}
			// Mock 直播流（数据概览页「开始直播」时，对应评委也一定在线）
			mockLiveStreamIds.forEach(streamId => {
				const cfg = db.judges.get(streamId);
				(cfg.judges || []).forEach(j => {
					const uid = j.userId || (j.id === 'judge-1' ? 'judge-user-1' : j.id === 'judge-2' ? 'judge-user-2' : j.id === 'judge-3' ? 'judge-user-3' : null);
					if (uid) judgeUserIds.add(uid);
				});
			});
		}
		const audienceEligible = eligible.filter(u => !judgeUserIds.has(u.id));
		// 紫色导航栏在线用户 = 各直播间在线人数之和（不超过 38），多直播间在线人数不能多于该值
		const totalOnlineCap = 38;
		const sumOnline = Object.values(streamOnlineCounts).reduce((a, b) => a + (b || 0), 0);
		let activeUsers = anyLive ? Math.min(totalOnlineCap, sumOnline) : 0;
		let audienceOnlineSet = new Set();
		if (anyLive && activeUsers > 0) {
			const shuffled = audienceEligible.slice().sort(() => Math.random() - 0.5);
			audienceOnlineSet = new Set(shuffled.slice(0, Math.max(0, activeUsers - judgeUserIds.size)).map(u => u.id));
		}
		try {
			for (const u of allUsers) {
				if (u.status === 'banned') continue;
				const isOnline = judgeUserIds.has(u.id) || audienceOnlineSet.has(u.id);
				db.users.setStatus(u.id, isOnline ? 'online' : 'offline');
			}
		} catch (e) {
			// 忽略状态更新失败
		}

		// 当前流（用于返回该流票数与状态）
		const sid = req.query.stream_id || (db.streams.getActive() ? db.streams.getActive().id : (db.streams.getAll()[0] ? db.streams.getAll()[0].id : null));
		const streamStatus = sid ? (streamLiveStatuses[sid] || { isLive: false }) : { isLive: false };
		const isMockLive = sid && mockLiveStreamIds && mockLiveStreamIds.has(sid);
		const streamIsLive = !!(streamStatus.isLive || isMockLive);
		// 大屏展示本场票数（直播/Mock 直播用本场，未直播用当前票数）
		const v = sid ? (streamIsLive ? getLiveSessionVotes(sid) : getVotesState(sid)) : { leftVotes: 0, rightVotes: 0 };
		const curV = sid ? getVotesState(sid) : { leftVotes: 0, rightVotes: 0 };
		const streamTotalVotes = (v.leftVotes || 0) + (v.rightVotes || 0);
		const allTotalVotes = getAllVotesTotal();
		// 总投票数：所有直播每一次投票的累计，持久化；每次加上覆盖显示值
		const stats = db.statistics.get();
		const globalTotalVotes = (stats && stats.totalVotes != null) ? stats.totalVotes : allTotalVotes;

		const leftVotes = v.leftVotes || 0;
		const rightVotes = v.rightVotes || 0;
		// 票数管理页用「当前票数」（可手动修改）；直播时与 leftVotes/rightVotes 可能不同
		const currentLeftVotes = curV.leftVotes || 0;
		const currentRightVotes = curV.rightVotes || 0;
		// 大屏只展示本次直播票数：开播时该流已置 0，不累计之前场次
		// 该流的AI状态（优先按流，否则全局）
		const aiStatus = (streamAIStatuses[sid] && streamAIStatuses[sid].status === 'running')
			? 'running' : (globalAIStatus.status === 'running' ? 'running' : 'stopped');
		// 该流在线人数、累计观看人数（未直播时为 0）
		const streamOnlineUsers = sid ? (streamOnlineCounts[sid] || 0) : 0;
		const streamViewersCount = sid ? (streamViewers[sid] ?? db.streamViewersDb.get(sid)) : 0;
		res.json({
			success: true,
			data: {
				totalUsers,
				activeUsers,
				isLive: anyLive,
				leftVotes,
				rightVotes,
				totalVotes: streamTotalVotes,      // 当前流总票数（大屏/卡片直播中=本场）
				allTotalVotes: allTotalVotes,     // 所有直播流当前票数和
				globalTotalVotes: globalTotalVotes, // 总投票数：所有直播每一次投票累计，持久化
				streamId: sid,
				streamOnlineUsers,                 // 该流在线人数
				streamViewers: streamViewersCount, // 该流累计观看人数（只增不减）
				aiStatus,
				judgeVotes: (sid && streamJudgeVotes[sid]) ? streamJudgeVotes[sid] : [],
				liveStatus: {
					isLive: !!streamIsLive,
					liveId: streamStatus.liveId || null,
					startTime: streamStatus.startTime || null,
					stopTime: streamStatus.stopTime || null
				},
				// 票数管理页「当前票数」（可手动修改）；直播时可能与 leftVotes/rightVotes 不同
				currentLeftVotes,
				currentRightVotes,
				// 大屏专用：直播/Mock 直播时本场票数（与 leftVotes/rightVotes 一致）
				...(streamIsLive ? { liveSessionLeft: leftVotes, liveSessionRight: rightVotes } : {})
			}
		});
	} catch (e) {
		console.error('dashboard mock 失败:', e);
		res.status(500).json({ success: false, message: e.message });
	}
}
app.get('/api/v1/admin/dashboard', getDashboardMock);

// GET /api/v1/admin/live/viewers - 获取观看人数（单流或全部）
app.get('/api/v1/admin/live/viewers', (req, res) => {
	try {
		const dbLocal = require(ADMIN_DB_PATH);
		const streamId = req.query.stream_id || null;
		const streams = dbLocal.streams.getAll();
		const viewersMap = dbLocal.streamViewersDb.getAll();
		Object.keys(viewersMap || {}).forEach(sid => {
			if (streamViewers[sid] == null) streamViewers[sid] = viewersMap[sid];
		});
		if (streamId) {
			const viewers = streamViewers[streamId] ?? dbLocal.streamViewersDb.get(streamId);
			return res.json({
				success: true,
				data: { streamId, viewers: viewers || 0, timestamp: new Date().toISOString() },
				timestamp: Date.now()
			});
		}
		const streamsData = {};
		streams.forEach(s => {
			streamsData[s.id] = streamViewers[s.id] ?? dbLocal.streamViewersDb.get(s.id);
		});
		const totalConnections = Object.values(streamsData).reduce((sum, n) => sum + (n || 0), 0);
		res.json({
			success: true,
			data: { streams: streamsData, totalConnections, timestamp: new Date().toISOString() },
			timestamp: Date.now()
		});
	} catch (e) {
		console.error('GET /api/v1/admin/live/viewers 失败:', e);
		res.status(500).json({ success: false, message: e.message });
	}
});

console.log('✅ 直播流 / 辩题 / 用户 / Dashboard / 观看人数 API 已注册（本地 db，优先于代理）');

// ==================== 优先代理到后端服务器（如果启用） ====================
// 评委、用户、头像等走网关本地 db，不代理到后端
const LOCAL_API_PATHS = ['/api/admin/judges', '/api/admin/users', '/api/admin/upload/avatar', '/api/admin/debate-flow', '/api/v1/admin/dashboard', '/api/admin/ai-content', '/api/v1/admin/ai-content', '/api/admin/live', '/api/v1/admin/live', '/api/admin/statistics'];
const isLocalApi = (path) => LOCAL_API_PATHS.some(p => path === p || path.startsWith(p + '?') || path.startsWith(p + '/'));

if (PRIORITIZE_BACKEND_SERVER && BACKEND_SERVER_URL) {
	console.log('🔗 启用后端服务器优先模式：API 请求代理到后端（评委/用户/头像等走本地）');
	console.log(`🔗 后端服务器地址: ${BACKEND_SERVER_URL}`);
	
	const backendProxy = createProxyMiddleware({
		target: BACKEND_SERVER_URL,
		changeOrigin: true,
		pathRewrite: { '^/api': '/api' },
		logger: console,
		onProxyReq: (proxyReq, req, res) => {
			console.log(`🔄 [代理] ${req.method} ${req.path} -> ${BACKEND_SERVER_URL}${req.path}`);
		},
		onProxyRes: (proxyRes, req, res) => {
			console.log(`✅ [代理] ${req.path} <- ${proxyRes.statusCode} ${BACKEND_SERVER_URL}`);
		},
		onError: (err, req, res) => {
			console.error(`❌ [代理错误] ${req.path}:`, err.message);
			if (!res.headersSent) {
				res.status(502).json({
					success: false,
					error: 'Bad Gateway',
					message: `无法连接到后端服务器 ${BACKEND_SERVER_URL}`,
					path: req.path,
					details: err.message
				});
			}
		}
	});
	
	// 评委/用户/头像、AI 内容等走本地，其余 /api 代理到后端
	// 注意：挂载在 /api 时 req.path 为相对路径（如 /admin/ai-content），需用完整路径判断
	app.use('/api', (req, res, next) => {
		const fullPath = (req.baseUrl || '') + (req.path || '') || req.originalUrl?.split('?')[0] || req.path;
		if (isLocalApi(fullPath)) {
			return next(); // 交给已注册的本地路由处理
		}
		backendProxy(req, res, next);
	});
	console.log('✅ 代理中间件已配置（评委/用户/头像走本地）');
}

// ==================== 直播流代理（SRS 服务器） ====================
// 将直播流请求代理到 SRS 服务器，让小程序通过中间层访问
const SRS_SERVER_URL = 'http://192.168.43.247:8086';

const srsProxy = createProxyMiddleware({
	target: SRS_SERVER_URL,
	changeOrigin: true,
	logger: console,
	// 路径重写：保留 /live 前缀
	// 请求: /live/test.m3u8 -> 转发到: http://192.168.43.247:8086/live/test.m3u8
	// 注意：app.use('/live', proxy) 会自动移除 /live 前缀，所以需要手动加回来
	pathRewrite: (path, req) => {
		// 如果路径不包含 /live，添加 /live 前缀
		if (!path.startsWith('/live')) {
			return '/live' + path;
		}
		return path;
	},
	onProxyReq: (proxyReq, req, res) => {
		console.log(`📺 [直播流代理] ${req.method} ${req.path} -> ${SRS_SERVER_URL}${proxyReq.path}`);
	},
	onProxyRes: (proxyRes, req, res) => {
		// 设置 CORS 头，允许小程序访问
		proxyRes.headers['Access-Control-Allow-Origin'] = '*';
		proxyRes.headers['Access-Control-Allow-Methods'] = 'GET, HEAD, OPTIONS';
		proxyRes.headers['Access-Control-Allow-Headers'] = 'Content-Type, Range';
		proxyRes.headers['Access-Control-Expose-Headers'] = 'Content-Length, Content-Range';
		console.log(`✅ [直播流代理] ${req.path} <- ${proxyRes.statusCode} ${SRS_SERVER_URL}`);
	},
	onError: (err, req, res) => {
		console.error(`❌ [直播流代理错误] ${req.path}:`, err.message);
		if (!res.headersSent) {
			res.status(502).json({
				success: false,
				error: 'Bad Gateway',
				message: `无法连接到 SRS 服务器 ${SRS_SERVER_URL}`,
				path: req.path,
				details: err.message
			});
		}
	}
});

// 在所有路由之前添加直播流代理（在 API 代理之后，但在其他路由之前）
app.use('/live', srsProxy);
console.log('✅ 直播流代理已配置: /live/* -> ' + SRS_SERVER_URL);

// ==================== 后台管理 API（仅在非优先后端模式时使用） ====================
// db 已在文件前部 require，此处复用

// 管理API - 直播流管理（完整实现见下方 ==================== 直播流管理接口 ==================== 部分）

// 管理API - 辩论设置
app.get('/api/admin/debate', (req, res) => {
	try {
		const debate = db.debate.get();
		res.json(debate);
	} catch (error) {
		console.error('获取辩论设置失败:', error);
		res.status(500).json({ error: '获取失败' });
	}
});

app.put('/api/admin/debate', (req, res) => {
	try {
		const debate = db.debate.update(req.body);
		// 同步更新内存中的辩题
		debateTopic.title = debate.title;
		debateTopic.description = debate.description;
		
		// 广播辩论设置更新给所有客户端（包括小程序）
		broadcast('debate-updated', {
			debate: debate,
			timestamp: Date.now()
		});
		
		res.json(debate);
	} catch (error) {
		console.error('更新辩论设置失败:', error);
		res.status(500).json({ error: '更新失败' });
	}
});

// 管理API - 用户管理
app.get('/api/admin/users', (req, res) => {
	try {
		const users = db.users.getAll();
		res.json(users);
	} catch (error) {
		console.error('获取用户列表失败:', error);
		res.status(500).json({ error: '获取失败' });
	}
});

app.get('/api/admin/users/:id', (req, res) => {
	try {
		const user = db.users.getById(req.params.id);
		if (!user) {
			return res.status(404).json({ error: '用户不存在' });
		}
		res.json(user);
	} catch (error) {
		console.error('获取用户失败:', error);
		res.status(500).json({ error: '获取失败' });
	}
});

// 获取当前辩题（小程序调用）- 完整实现见下方 API路由 部分

// 添加直播状态控制 API
let globalLiveStatus = {
	isLive: false,
	streamUrl: null,
	scheduledStartTime: null,
	scheduledEndTime: null,
	streamId: null,
	isScheduled: false,
	liveId: null,
	startTime: null
};

// 每个流的独立直播状态（支持多流同时管理）
// 格式: { streamId: { isLive: true/false, liveId: 'xxx', startTime: 'xxx', streamUrl: 'xxx' } }
let streamLiveStatuses = {};

// Mock 模式下的直播流 ID 集合（数据概览页「开始直播」时同步，用于评委在线、投票记录等）
let mockLiveStreamIds = new Set();

// 每次开播的投票会话（用于“每人只能投一次”与投票窗口）
// key: `${streamId}:${liveId}` -> { votedUsers: Set<string>, judgesVoted: Set<string> }
const voteSessions = new Map();

// 每流定时器：用于 45-60s 投票窗口与 60s 自动关播
const streamTimers = new Map(); // streamId -> { judgeTimer, autoStopTimer }

// 添加AI识别状态管理
let globalAIStatus = {
	status: 'stopped',  // stopped / running / paused
	aiSessionId: null,
	startTime: null,
	settings: {
		mode: 'realtime',
		interval: 5000,
		sensitivity: 'high',
		minConfidence: 0.7
	},
	statistics: {
		totalContents: 0,
		totalWords: 0,
		averageConfidence: 0
	}
};

// 每个流的独立AI状态（支持多流各自控制AI）
// 格式: { streamId: { status: 'stopped'|'running', aiSessionId, startTime } }
let streamAIStatuses = {};

// 全局在线人数上限（不超过总用户数 38）
const TOTAL_USERS = 38;
// 单条流在线人数上限 = 总用户数/5（如 38→7）
const PER_STREAM_ONLINE_CAP = Math.max(1, Math.floor(TOTAL_USERS / 5));

// 每个流的在线人数（直播时从 0 开始，每 8-12 秒波动 ±1-2，单流上限 PER_STREAM_ONLINE_CAP）
let streamOnlineCounts = {};
// 每个流的在线用户 ID 集合（用于动态随机投票：从在线用户/评委中选一人投票）
let streamOnlineUserIds = {};
// 每个流的观看人数 = 本场累计（在线人数增加量累加）；关播归零，新开播从 0 开始
let streamViewers = {};
// 每个流的评委投票明细（大屏展示用，模拟投票时写入）
let streamJudgeVotes = {};

// 定时检查直播计划
let liveScheduleTimer = null;
let lastStopTime = 0; // 记录上次停止直播的时间，防止误触发自动重启

// 观看人数：按开播后时段增长，上限 = 单流在线上限×3（初期 0-6s 每 2s +1~2；中期 6-12s 每 3s +2-3；后期 12-16s +0-1）
let streamViewersLastTick = {};
setInterval(() => {
	const dbLocal = require(ADMIN_DB_PATH);
	const now = Date.now();
	const liveStreamIds = new Set(
		Object.entries(streamLiveStatuses).filter(([, st]) => st && st.isLive).map(([sid]) => sid)
	);
	mockLiveStreamIds.forEach(sid => liveStreamIds.add(sid));
	liveStreamIds.forEach(sid => {
		const st = streamLiveStatuses[sid];
		const startTime = st && st.startTime ? new Date(st.startTime).getTime() : now;
		const elapsed = (now - startTime) / 1000;
		const onlineCap = PER_STREAM_ONLINE_CAP;
		const viewerCap = onlineCap * 3;
		const current = streamViewers[sid] ?? dbLocal.streamViewersDb.get(sid);
		if (current >= viewerCap) return;
		let delta = 0;
		if (elapsed < 6) {
			if (!streamViewersLastTick[sid]) streamViewersLastTick[sid] = 0;
			if (now - streamViewersLastTick[sid] >= 2000) {
				delta = 1 + Math.floor(Math.random() * 2);
				streamViewersLastTick[sid] = now;
			}
		} else if (elapsed < 12) {
			if (!streamViewersLastTick[sid]) streamViewersLastTick[sid] = now;
			if (now - streamViewersLastTick[sid] >= 3000) {
				delta = 2 + Math.floor(Math.random() * 2);
				streamViewersLastTick[sid] = now;
			}
		} else if (elapsed < 16) {
			if (!streamViewersLastTick[sid]) streamViewersLastTick[sid] = now;
			if (now - streamViewersLastTick[sid] >= 4000) {
				delta = Math.floor(Math.random() * 2);
				streamViewersLastTick[sid] = now;
			}
		}
		if (delta > 0) {
			const next = Math.min(viewerCap, current + delta);
			const actual = next - current;
			if (actual > 0) {
				const written = dbLocal.streamViewersDb.add(sid, actual);
				streamViewers[sid] = written;
			}
		}
	});
}, 2000);

// 刷新某流的在线用户集合：评委 + 随机观众，总人数 = streamOnlineCounts[streamId]（可为 0）
function refreshStreamOnlineUserIds(streamId) {
	const count = Math.max(0, streamOnlineCounts[streamId] || 0);
	if (count === 0) {
		streamOnlineUserIds[streamId] = new Set();
		return new Set();
	}
	const dbLocal = require(ADMIN_DB_PATH);
	const judgeCfg = dbLocal.judges.get(streamId);
	const judgeIds = new Set((judgeCfg.judges || []).map(j => j.userId || (j.id === 'judge-1' ? 'judge-user-1' : j.id === 'judge-2' ? 'judge-user-2' : j.id === 'judge-3' ? 'judge-user-3' : null)).filter(Boolean));
	const allUsers = dbLocal.users.getAll().filter(u => u.status !== 'banned');
	const audience = allUsers.filter(u => !judgeIds.has(u.id));
	const set = new Set(judgeIds);
	const need = Math.max(0, count - set.size);
	const shuffled = audience.slice().sort(() => Math.random() - 0.5);
	for (let i = 0; i < need && i < shuffled.length; i++) set.add(shuffled[i].id);
	streamOnlineUserIds[streamId] = set;
	return set;
}

// 动态随机投票：直播中每 3-5 秒，随机选 1 位在线用户或评委投票（用户 2 票/评委 10 票，全投同一阵营）
function doDynamicRandomVote() {
	const anyLive = Object.values(streamLiveStatuses).some(s => s && s.isLive) || mockLiveStreamIds.size > 0;
	if (!anyLive) return;
	const dbLocal = require(ADMIN_DB_PATH);
	const streamsToTick = [];
	for (const [sid, st] of Object.entries(streamLiveStatuses)) {
		if (st && st.isLive && streamOnlineCounts[sid] > 0) streamsToTick.push(sid);
	}
	mockLiveStreamIds.forEach(sid => {
		if (!streamsToTick.includes(sid)) streamsToTick.push(sid);
	});
	for (const streamId of streamsToTick) {
		let onlineSet = streamOnlineUserIds[streamId];
		if (!onlineSet || onlineSet.size === 0) {
			onlineSet = refreshStreamOnlineUserIds(streamId);
		}
		if (onlineSet.size === 0) continue;
		const arr = Array.from(onlineSet);
		const userId = arr[Math.floor(Math.random() * arr.length)];
		const judgeCfg = dbLocal.judges.get(streamId);
		const judgeIds = new Set((judgeCfg.judges || []).map(j => j.userId || (j.id === 'judge-1' ? 'judge-user-1' : j.id === 'judge-2' ? 'judge-user-2' : j.id === 'judge-3' ? 'judge-user-3' : null)).filter(Boolean));
		const isJudge = judgeIds.has(userId);
		const voteCount = isJudge ? 10 : 2; // 评委 10 票，普通用户 2 票
		const side = Math.random() < 0.5 ? 'left' : 'right';
		if (side === 'left') {
			addVotesState(streamId, voteCount, 0);
			addLiveSessionVotes(streamId, voteCount, 0);
		} else {
			addVotesState(streamId, 0, voteCount);
			addLiveSessionVotes(streamId, 0, voteCount);
		}
		dbLocal.users.appendVoteRecord(userId, { streamId, liveId: 'dynamic', side, votes: voteCount, at: new Date().toISOString() });
		dbLocal.statistics.incrementVotes(voteCount);
		const v = getVotesState(streamId);
		const total = (v.leftVotes || 0) + (v.rightVotes || 0);
		const statsNow = dbLocal.statistics.get();
		const dynPayload = { streamId, leftVotes: v.leftVotes, rightVotes: v.rightVotes, totalVotes: total, allTotalVotes: getAllVotesTotal(), globalTotalVotes: (statsNow && statsNow.totalVotes != null) ? statsNow.totalVotes : getAllVotesTotal(), source: 'dynamic', timestamp: new Date().toISOString() };
		const stDyn = streamLiveStatuses[streamId];
		if (stDyn && stDyn.isLive) {
			const sessionV = getLiveSessionVotes(streamId);
			dynPayload.liveSessionLeft = sessionV.leftVotes;
			dynPayload.liveSessionRight = sessionV.rightVotes;
		}
		broadcast('votes-updated', dynPayload);
	}
}

// 获取当前所有流在线人数总和（不超过 TOTAL_USERS）
function getTotalOnlineCount() {
	return Object.values(streamOnlineCounts).reduce((s, n) => s + (n || 0), 0);
}

// 在线人数动态波动：直播中每 8-12 秒，单流 ±1-2 人；单流上限 PER_STREAM_ONLINE_CAP，总和不超过 TOTAL_USERS
function doOnlineCountFluctuation() {
	const streamsToTick = [];
	for (const [sid, st] of Object.entries(streamLiveStatuses)) {
		if (st && st.isLive) streamsToTick.push(sid);
	}
	mockLiveStreamIds.forEach(sid => {
		if (!streamsToTick.includes(sid)) streamsToTick.push(sid);
	});
	for (const streamId of streamsToTick) {
		const cur = streamOnlineCounts[streamId] || 0;
		const otherSum = getTotalOnlineCount() - cur;
		const headroom = Math.max(0, TOTAL_USERS - otherSum);
		const streamCap = Math.min(PER_STREAM_ONLINE_CAP, headroom);
		const delta = (Math.random() < 0.5 ? -1 : 1) * (1 + Math.floor(Math.random() * 2)); // ±1 或 ±2
		let next = Math.max(0, Math.min(streamCap, cur + delta));
		next = Math.min(next, TOTAL_USERS - otherSum);
		// 观看人数 = 在线人数增加量累加：在线从 3 变 7 则观看人数 +4
		const viewerDelta = Math.max(0, next - cur);
		if (viewerDelta > 0) {
			try {
				const dbLocal = require(ADMIN_DB_PATH);
				const written = dbLocal.streamViewersDb.add(streamId, viewerDelta);
				streamViewers[streamId] = written;
			} catch (e) { /* ignore */ }
		}
		streamOnlineCounts[streamId] = next;
		refreshStreamOnlineUserIds(streamId);
	}
	// 推送在线人数变化，供管理端实时更新（每个直播流在线人数有增有降）
	try {
		broadcast('stream-online-update', { streamOnlineCounts: { ...streamOnlineCounts } });
	} catch (e) { /* ignore */ }
}

function checkLiveSchedule() {
	const db = require(ADMIN_DB_PATH);
	const schedule = db.liveSchedule.get();
	const now = Date.now();
	
	if (schedule.isScheduled && schedule.scheduledStartTime) {
		const startTime = new Date(schedule.scheduledStartTime).getTime();
		
		// 🔧 修复：如果到了开始时间且还未开始
		if (now >= startTime && !globalLiveStatus.isLive) {
			// 检查是否刚刚停止直播（2分钟内）
			const timeSinceStop = now - lastStopTime;
			if (timeSinceStop < 120000) { // 2分钟内
				console.log(`⚠️ [定时检查] 检测到计划开始时间已到，但在${Math.floor(timeSinceStop/1000)}秒前刚停止直播，跳过自动启动，防止误触发`);
				// 清除这个过期的计划
				db.liveSchedule.clear();
				globalLiveStatus.isScheduled = false;
				globalLiveStatus.scheduledStartTime = null;
				globalLiveStatus.scheduledEndTime = null;
				return;
			}
			
			console.log('⏰ [定时检查] 定时开始直播');
			startScheduledLive(schedule);
		}
		
		// 如果有结束时间且已到结束时间
		if (schedule.scheduledEndTime && globalLiveStatus.isLive) {
			const endTime = new Date(schedule.scheduledEndTime).getTime();
			if (now >= endTime) {
				console.log('⏰ [定时检查] 定时结束直播');
				lastStopTime = Date.now(); // 记录停止时间
				stopLive();
			}
		}
	}
}

// 启动定时检查（每分钟检查一次）
function startScheduleCheck() {
	if (liveScheduleTimer) {
		clearInterval(liveScheduleTimer);
	}
	liveScheduleTimer = setInterval(checkLiveSchedule, 60000); // 每分钟检查一次
}

// 启动计划的直播
function startScheduledLive(schedule) {
	const db = require(ADMIN_DB_PATH);
	
	try {
		let streamUrl = null;
		
		// 获取直播流
		if (schedule.streamId) {
			const stream = db.streams.getById(schedule.streamId);
			if (stream && stream.enabled) {
				streamUrl = stream.url;
			}
		}
		
		if (!streamUrl) {
			const activeStream = db.streams.getActive();
			if (activeStream) {
				streamUrl = activeStream.url;
			}
		}
		
		if (!streamUrl) {
			console.error('❌ 没有可用的直播流');
			return;
		}
		
		globalLiveStatus.isLive = true;
		globalLiveStatus.streamUrl = streamUrl;
		globalLiveStatus.streamId = schedule.streamId;
		
		// 广播直播状态变化
		broadcast('live-status-changed', {
			status: 'started',
			streamUrl: globalLiveStatus.streamUrl,
			timestamp: Date.now(),
			scheduled: true
		});
		
		console.log('✅ 直播已开始:', streamUrl);
	} catch (error) {
		console.error('启动计划直播失败:', error);
	}
}

// 停止直播
function stopLive() {
	globalLiveStatus.isLive = false;
	globalLiveStatus.streamUrl = null;
	globalLiveStatus.streamId = null;
	
	// 清除计划
	const db = require(ADMIN_DB_PATH);
	db.liveSchedule.clear();
	globalLiveStatus.isScheduled = false;
	globalLiveStatus.scheduledStartTime = null;
	globalLiveStatus.scheduledEndTime = null;
	
	// 广播直播状态变化
	broadcast('live-status-changed', {
		status: 'stopped',
		timestamp: Date.now()
	});
	
		console.log('🛑 直播已停止');
}

// 管理端直播控制接口（管理员专用）
app.post('/api/admin/live/control', (req, res) => {
	try {
		const { action, streamUrl } = req.body;
		
		if (action === 'start') {
			if (!streamUrl) {
				const db = require(ADMIN_DB_PATH);
				const activeStream = db.streams.getActive();
				if (!activeStream) {
					return res.status(400).json({ error: '没有可用的直播流' });
				}
				globalLiveStatus.streamUrl = activeStream.url;
			} else {
				globalLiveStatus.streamUrl = streamUrl;
			}
			globalLiveStatus.isLive = true;
			
			// 广播直播状态变化
			broadcast('live-status-changed', {
				status: 'started',
				streamUrl: globalLiveStatus.streamUrl,
				timestamp: Date.now()
			});
			
			res.json({ success: true, status: 'started', streamUrl: globalLiveStatus.streamUrl });
		} else if (action === 'stop') {
			stopLive();
			res.json({ success: true, status: 'stopped' });
		} else {
			res.status(400).json({ error: '无效的操作' });
		}
	} catch (error) {
		console.error('控制直播状态失败:', error);
		res.status(500).json({ error: '操作失败' });
	}
});

// 公开的直播控制接口（用户可直接调用）
app.post('/api/live/control', (req, res) => {
	try {
		const { action, streamId } = req.body;
		
		if (action === 'start') {
			const db = require(ADMIN_DB_PATH);
			let selectedStream = null;
			
			// 如果指定了streamId，使用指定的直播流
			if (streamId) {
				selectedStream = db.streams.getById(streamId);
				if (!selectedStream) {
					return res.status(400).json({ 
						success: false,
						message: '指定的直播流不存在' 
					});
				}
				if (!selectedStream.enabled) {
					return res.status(400).json({ 
						success: false,
						message: '指定的直播流未启用' 
					});
				}
			} else {
				// 否则使用启用的直播流
				selectedStream = db.streams.getActive();
				if (!selectedStream) {
					return res.status(400).json({ 
						success: false,
						message: '没有可用的直播流，请先在后台管理系统中配置直播流' 
					});
				}
			}
			
			// 开始直播
			globalLiveStatus.isLive = true;
			globalLiveStatus.streamUrl = selectedStream.url;
			globalLiveStatus.streamId = selectedStream.id;
			globalLiveStatus.isScheduled = false;
			globalLiveStatus.scheduledStartTime = null;
			globalLiveStatus.scheduledEndTime = null;
			
			// 清除之前的计划
			db.liveSchedule.clear();
			
			// 广播直播状态变化
			broadcast('live-status-changed', {
				status: 'started',
				streamUrl: globalLiveStatus.streamUrl,
				timestamp: Date.now(),
				startedBy: 'user'
			});
			
			console.log('✅ 用户启动直播:', selectedStream.name, selectedStream.url);
			
			res.json({ 
				success: true, 
				message: '直播已开始',
				data: {
					status: 'started',
					streamUrl: globalLiveStatus.streamUrl,
					streamId: selectedStream.id,
					streamName: selectedStream.name
				}
			});
		} else if (action === 'stop') {
			stopLive();
			console.log('✅ 用户停止直播');
			res.json({ 
				success: true, 
				message: '直播已停止',
				data: {
					status: 'stopped'
				}
			});
		} else {
			res.status(400).json({ 
				success: false,
				message: '无效的操作，action 必须是 "start" 或 "stop"' 
			});
		}
	} catch (error) {
		console.error('用户控制直播状态失败:', error);
		res.status(500).json({ 
			success: false,
			message: '操作失败: ' + error.message 
		});
	}
});

// 设置直播计划
app.post('/api/admin/live/schedule', (req, res) => {
	try {
		const db = require(ADMIN_DB_PATH);
		const { scheduledStartTime, scheduledEndTime, streamId } = req.body;
		
		if (!scheduledStartTime) {
			return res.status(400).json({ error: '请设置直播开始时间' });
		}
		
		const startTime = new Date(scheduledStartTime).getTime();
		const now = Date.now();
		
		if (startTime <= now) {
			return res.status(400).json({ error: '开始时间必须晚于当前时间' });
		}
		
		// 验证直播流
		if (streamId) {
			const stream = db.streams.getById(streamId);
			if (!stream) {
				return res.status(400).json({ error: '指定的直播流不存在' });
			}
			if (!stream.enabled) {
				return res.status(400).json({ error: '指定的直播流未启用' });
			}
		} else {
			const activeStream = db.streams.getActive();
			if (!activeStream) {
				return res.status(400).json({ error: '没有可用的直播流' });
			}
		}
		
		// 保存计划
		const schedule = db.liveSchedule.update({
			scheduledStartTime,
			scheduledEndTime: scheduledEndTime || null,
			streamId: streamId || null,
			isScheduled: true
		});
		
		globalLiveStatus.scheduledStartTime = scheduledStartTime;
		globalLiveStatus.scheduledEndTime = scheduledEndTime || null;
		globalLiveStatus.streamId = streamId || null;
		globalLiveStatus.isScheduled = true;
		
		// 启动定时检查
		startScheduleCheck();
		
		// 广播计划更新
		broadcast('live-schedule-updated', {
			schedule: schedule,
			timestamp: Date.now()
		});
		
		res.json({
			success: true,
			message: '直播计划已设置',
			data: schedule
		});
	} catch (error) {
		console.error('设置直播计划失败:', error);
		res.status(500).json({ error: '设置失败' });
	}
});

// 获取直播计划
app.get('/api/admin/live/schedule', (req, res) => {
	try {
		const db = require(ADMIN_DB_PATH);
		const schedule = db.liveSchedule.get();
		res.json({
			success: true,
			data: schedule
		});
	} catch (error) {
		res.status(500).json({ error: '获取失败' });
	}
});

// 取消直播计划
app.post('/api/admin/live/schedule/cancel', (req, res) => {
	try {
		const db = require(ADMIN_DB_PATH);
		db.liveSchedule.clear();
		
		globalLiveStatus.isScheduled = false;
		globalLiveStatus.scheduledStartTime = null;
		globalLiveStatus.scheduledEndTime = null;
		
		// 广播计划取消
		broadcast('live-schedule-cancelled', {
			timestamp: Date.now()
		});
		
		res.json({
			success: true,
			message: '直播计划已取消'
		});
	} catch (error) {
		res.status(500).json({ error: '取消失败' });
	}
});

app.get('/api/admin/live/status', (req, res) => {
	try {
		const db = require(ADMIN_DB_PATH);
		const schedule = db.liveSchedule.get();
		
		// 获取启用的直播流（即使直播未开始，也返回启用的流地址）
		let activeStream = null;
		try {
			activeStream = db.streams.getActive();
		} catch (error) {
			console.warn('获取启用直播流失败:', error);
		}
		
		res.json({
			...globalLiveStatus,
			schedule: schedule,
			// 如果直播未开始但有启用的流，返回流地址以便小程序使用
			activeStreamUrl: activeStream ? activeStream.url : null,
			activeStreamId: activeStream ? activeStream.id : null,
			activeStreamName: activeStream ? activeStream.name : null
		});
	} catch (error) {
		res.json(globalLiveStatus);
	}
});

// 一次性设置并开始直播（整合API）
app.post('/api/admin/live/setup-and-start', (req, res) => {
	try {
		const db = require(ADMIN_DB_PATH);
		const { streamId, scheduledStartTime, scheduledEndTime, startNow } = req.body;
		
		// 验证直播流
		let selectedStream = null;
		if (streamId) {
			selectedStream = db.streams.getById(streamId);
			if (!selectedStream) {
				return res.status(400).json({ error: '指定的直播流不存在' });
			}
			if (!selectedStream.enabled) {
				return res.status(400).json({ error: '指定的直播流未启用' });
			}
		} else {
			selectedStream = db.streams.getActive();
			if (!selectedStream) {
				return res.status(400).json({ error: '没有可用的直播流' });
			}
		}
		
		if (startNow) {
			// 立即开始直播
			globalLiveStatus.isLive = true;
			globalLiveStatus.streamUrl = selectedStream.url;
			globalLiveStatus.streamId = selectedStream.id;
			globalLiveStatus.isScheduled = false;
			globalLiveStatus.scheduledStartTime = null;
			globalLiveStatus.scheduledEndTime = null;
			
			// 清除之前的计划
			db.liveSchedule.clear();
			
			// 广播直播状态变化
			broadcast('live-status-changed', {
				status: 'started',
				streamUrl: globalLiveStatus.streamUrl,
				timestamp: Date.now(),
				startedBy: 'admin'
			});
			
			res.json({
				success: true,
				message: '直播已开始',
				data: {
					isLive: true,
					streamUrl: globalLiveStatus.streamUrl,
					streamId: selectedStream.id
				}
			});
		} else {
			// 设置定时开始
			if (!scheduledStartTime) {
				return res.status(400).json({ error: '请设置直播开始时间' });
			}
			
			const startTime = new Date(scheduledStartTime).getTime();
			const now = Date.now();
			
			if (startTime <= now) {
				return res.status(400).json({ error: '开始时间必须晚于当前时间' });
			}
			
			// 保存计划
			const schedule = db.liveSchedule.update({
				scheduledStartTime,
				scheduledEndTime: scheduledEndTime || null,
				streamId: selectedStream.id,
				isScheduled: true
			});
			
			globalLiveStatus.scheduledStartTime = scheduledStartTime;
			globalLiveStatus.scheduledEndTime = scheduledEndTime || null;
			globalLiveStatus.streamId = selectedStream.id;
			globalLiveStatus.isScheduled = true;
			
			// 启动定时检查
			startScheduleCheck();
			
			// 广播计划更新
			broadcast('live-schedule-updated', {
				schedule: schedule,
				timestamp: Date.now()
			});
			
			res.json({
				success: true,
				message: '直播计划已设置',
				data: schedule
			});
		}
	} catch (error) {
		console.error('设置并开始直播失败:', error);
		res.status(500).json({ error: '操作失败' });
	}
});

// ==================== 票数管理 API ====================
app.get('/api/admin/votes', (req, res) => {
	try {
		const sid = req.query.stream_id || (globalLiveStatus && globalLiveStatus.streamId) || null;
		const v = sid ? getVotesState(sid) : { leftVotes: 0, rightVotes: 0 };
		const totalVotes = (v.leftVotes || 0) + (v.rightVotes || 0);
		res.json({
			success: true,
			data: {
				streamId: sid,
				leftVotes: v.leftVotes,
				rightVotes: v.rightVotes,
				totalVotes: totalVotes,
				leftPercentage: totalVotes > 0
					? Math.round((v.leftVotes / totalVotes) * 100)
					: 50,
				rightPercentage: totalVotes > 0
					? Math.round((v.rightVotes / totalVotes) * 100)
					: 50
			}
		});
	} catch (error) {
		res.status(500).json({ error: '获取票数失败' });
	}
});

app.put('/api/admin/votes', (req, res) => {
	try {
		const { leftVotes, rightVotes, streamId } = req.body;
		const sid = streamId || (globalLiveStatus && globalLiveStatus.streamId) || null;
		if (!sid) return res.status(400).json({ error: 'streamId 必填' });
		
		if (typeof leftVotes !== 'undefined' && typeof leftVotes !== 'number') {
			return res.status(400).json({ error: 'leftVotes 必须是数字' });
		}
		if (typeof rightVotes !== 'undefined' && typeof rightVotes !== 'number') {
			return res.status(400).json({ error: 'rightVotes 必须是数字' });
		}
		if ((typeof leftVotes !== 'undefined' && leftVotes < 0) || (typeof rightVotes !== 'undefined' && rightVotes < 0)) {
			return res.status(400).json({ error: '票数不能为负数' });
		}
		
		const cur = getVotesState(sid);
		if (typeof leftVotes !== 'undefined') cur.leftVotes = leftVotes;
		if (typeof rightVotes !== 'undefined') cur.rightVotes = rightVotes;
		
		// 广播票数更新
		const totalVotes = cur.leftVotes + cur.rightVotes;
		broadcast('vote-updated', {
			votes: {
				streamId: sid,
				leftVotes: cur.leftVotes,
				rightVotes: cur.rightVotes,
				totalVotes: totalVotes,
				leftPercentage: totalVotes > 0
					? Math.round((cur.leftVotes / totalVotes) * 100)
					: 50,
				rightPercentage: totalVotes > 0
					? Math.round((cur.rightVotes / totalVotes) * 100)
					: 50
			},
			updatedBy: 'admin'
		});
		
		res.json({
			success: true,
			data: {
				streamId: sid,
				leftVotes: cur.leftVotes,
				rightVotes: cur.rightVotes,
				totalVotes: totalVotes
			}
		});
	} catch (error) {
		res.status(500).json({ error: '修改票数失败' });
	}
});

app.post('/api/admin/votes/reset', (req, res) => {
	try {
		const sid = req.body.streamId || (globalLiveStatus && globalLiveStatus.streamId) || null;
		if (!sid) return res.status(400).json({ error: 'streamId 必填' });
		setVotesState(sid, 0, 0);
		
		// 广播票数重置
		broadcast('vote-updated', {
			votes: {
				streamId: sid,
				leftVotes: 0,
				rightVotes: 0,
				totalVotes: 0,
				leftPercentage: 50,
				rightPercentage: 50
			},
			updatedBy: 'admin',
			action: 'reset'
		});
		
		res.json({
			success: true,
			message: '票数已重置'
		});
	} catch (error) {
		res.status(500).json({ error: '重置票数失败' });
	}
});

// ==================== AI 内容管理 API ====================
app.get('/api/admin/ai-content', (req, res) => {
	try {
		res.json({
			success: true,
			data: aiDebateContent
		});
	} catch (error) {
		res.status(500).json({ error: '获取 AI 内容失败' });
	}
});

// ==================== v1 API 路由（兼容新版本前端） ====================
// 这些路由与上面的路由功能相同，但使用 /api/v1 前缀，支持认证token

// v1: 获取AI内容列表（必须在 /api/admin/ai-content/:id 之前定义，避免路由冲突）
app.get('/api/v1/admin/ai-content/list', (req, res) => {
	console.log('✅ v1 AI内容列表路由被调用:', req.query);
	try {
		const page = parseInt(req.query.page) || 1;
		const pageSize = parseInt(req.query.pageSize) || 20;
		const startTime = req.query.startTime || null;
		const endTime = req.query.endTime || null;
		const streamId = req.query.stream_id || null; // 🔧 添加 stream_id 参数支持
		
		// 验证pageSize最大值
		if (pageSize > 100) {
			return res.status(400).json({
				success: false,
				message: 'pageSize最大值为100'
			});
		}
		
		// 从 aiDebateContent 数组中获取数据
		let filteredContent = [...aiDebateContent];
		
		// 🔧 按 stream_id 过滤（如果提供）
		if (streamId) {
			filteredContent = filteredContent.filter(item => {
				// 如果内容有 streamId 字段，必须匹配
				// 如果内容没有 streamId 字段（旧数据），则不过滤（兼容旧数据）
				return !item.streamId || item.streamId === streamId;
			});
			console.log(`📊 按 stream_id=${streamId} 过滤后，剩余 ${filteredContent.length} 条数据`);
		}
		
		// 按时间过滤（如果有提供）
		if (startTime) {
			filteredContent = filteredContent.filter(item => {
				const itemTime = item.timestamp || item.createdAt || 0;
				return new Date(itemTime) >= new Date(startTime);
			});
		}
		if (endTime) {
			filteredContent = filteredContent.filter(item => {
				const itemTime = item.timestamp || item.createdAt || 0;
				return new Date(itemTime) <= new Date(endTime);
			});
		}
		
		// 计算总数
		const total = filteredContent.length;
		
		// 分页
		const start = (page - 1) * pageSize;
		const end = start + pageSize;
		const paginatedContent = filteredContent.slice(start, end);
		
		// 转换为文档格式
		const items = paginatedContent.map(item => {
			// 计算评论数
			const commentCount = (item.comments && Array.isArray(item.comments)) ? item.comments.length : 0;
			
			// 转换timestamp为ISO格式
			let timestampISO = '';
			if (item.timestamp) {
				// 如果是时间戳（数字），转换为ISO格式
				if (typeof item.timestamp === 'number') {
					timestampISO = new Date(item.timestamp).toISOString();
				} else {
					timestampISO = new Date(item.timestamp).toISOString();
				}
			} else if (item.createdAt) {
				timestampISO = new Date(item.createdAt).toISOString();
			} else {
				timestampISO = new Date().toISOString();
			}
			
			return {
				id: item.id,
				content: item.content || item.text || '', // 优先使用content，如果没有则使用text
				type: 'summary', // 固定值
				timestamp: timestampISO,
				position: item.position || item.side || 'left', // side转换为position
				confidence: item.confidence || 0.95, // 默认置信度
				statistics: {
					views: (item.statistics && item.statistics.views) || item.views || 0,
					likes: (item.statistics && item.statistics.likes) || item.likes || 0,
					comments: commentCount // 只返回数量，不返回详细评论
				}
			};
		});
		
		res.json({
			success: true,
			data: {
				total: total,
				page: page,
				items: items
			}
		});
		
	} catch (error) {
		console.error('获取AI内容列表失败:', error);
		res.status(500).json({
			success: false,
			message: '获取AI内容列表失败: ' + error.message
		});
	}
});

// AI内容列表（必须在 /api/admin/ai-content/:id 之前定义，避免路由冲突）
app.get('/api/admin/ai-content/list', (req, res) => {
	try {
		const page = parseInt(req.query.page) || 1;
		const pageSize = parseInt(req.query.pageSize) || 20;
		const startTime = req.query.startTime || null;
		const endTime = req.query.endTime || null;
		const streamId = req.query.stream_id || null; // 🔧 添加 stream_id 参数支持
		
		// 从 aiDebateContent 数组中获取数据
		let filteredContent = [...aiDebateContent];
		
		// 🔧 按 stream_id 过滤（如果提供）
		if (streamId) {
			filteredContent = filteredContent.filter(item => {
				// 如果内容有 streamId 字段，必须匹配
				// 如果内容没有 streamId 字段（旧数据），则不过滤（兼容旧数据）
				return !item.streamId || item.streamId === streamId;
			});
		}
		
		// 按时间过滤（如果有提供）
		if (startTime) {
			filteredContent = filteredContent.filter(item => 
				new Date(item.timestamp || item.createdAt || 0) >= new Date(startTime)
			);
		}
		if (endTime) {
			filteredContent = filteredContent.filter(item => 
				new Date(item.timestamp || item.createdAt || 0) <= new Date(endTime)
			);
		}
		
		// 计算总数
		const total = filteredContent.length;
		
		// 分页
		const start = (page - 1) * pageSize;
		const end = start + pageSize;
		const items = filteredContent.slice(start, end);
		
		res.json({
			success: true,
			data: {
				total: total,
				page: page,
				pageSize: pageSize,
				items: items
			},
			timestamp: Date.now()
		});
		
	} catch (error) {
		console.error('获取AI内容列表失败:', error);
		res.status(500).json({
			success: false,
			message: '获取AI内容列表失败: ' + error.message
		});
	}
});

app.get('/api/admin/ai-content/:id', (req, res) => {
	try {
		const { id } = req.params;
		const content = aiDebateContent.find(item => item.id === id);
		
		if (!content) {
			return res.status(404).json({ error: '内容不存在' });
		}
		
		res.json({
			success: true,
			data: content
		});
	} catch (error) {
		res.status(500).json({ error: '获取 AI 内容失败' });
	}
});

// 获取AI内容评论列表（必须在 /api/admin/ai-content/:id/comments/:commentId 之前定义）
app.get('/api/admin/ai-content/:id/comments', (req, res) => {
	try {
		const { id } = req.params;
		const page = parseInt(req.query.page) || 1;
		const pageSize = parseInt(req.query.pageSize) || 20;
		
		// 查找AI内容
		const content = aiDebateContent.find(item => item.id === id);
		
		if (!content) {
			return res.status(404).json({
				success: false,
				message: 'AI内容不存在'
			});
		}
		
		// 获取评论列表（从 content.comments 或 content.items.comments）
		let comments = [];
		if (content.comments && Array.isArray(content.comments)) {
			comments = content.comments;
		} else if (content.items && Array.isArray(content.items)) {
			// 如果评论在 items 数组中
			const contentItem = content.items.find(item => item.id === id);
			if (contentItem && contentItem.comments) {
				comments = contentItem.comments;
			}
		}
		
		// 分页
		const total = comments.length;
		const start = (page - 1) * pageSize;
		const end = start + pageSize;
		const paginatedComments = comments.slice(start, end);
		
		res.json({
			success: true,
			data: {
				contentId: id,
				contentText: content.content || content.text || '',
				total: total,
				page: page,
				pageSize: pageSize,
				comments: paginatedComments
			},
			timestamp: Date.now()
		});
		
	} catch (error) {
		console.error('获取AI内容评论列表失败:', error);
		res.status(500).json({
			success: false,
			message: '获取评论列表失败: ' + error.message
		});
	}
});

// 删除AI内容评论
app.delete('/api/admin/ai-content/:id/comments/:commentId', (req, res) => {
	try {
		const { id, commentId } = req.params;
		const { reason = '', notifyUsers = true } = req.body;
		
		// 查找AI内容
		const content = aiDebateContent.find(item => item.id === id);
		
		if (!content) {
			return res.status(404).json({
				success: false,
				message: 'AI内容不存在'
			});
		}
		
		// 获取评论列表
		let comments = [];
		if (content.comments && Array.isArray(content.comments)) {
			comments = content.comments;
		}
		
		// 查找评论
		const commentIndex = comments.findIndex(c => (c.commentId || c.id) === commentId);
		
		if (commentIndex === -1) {
			return res.status(404).json({
				success: false,
				message: '评论不存在'
			});
		}
		
		// 删除评论
		const deletedComment = comments.splice(commentIndex, 1)[0];
		
		// 更新内容中的评论数组
		content.comments = comments;
		
		// 更新统计数据
		if (content.statistics) {
			content.statistics.comments = (content.statistics.comments || 0) - 1;
		}
		
		// 如果通知用户，可以在这里发送WebSocket消息
		if (notifyUsers) {
			// broadcast('comment-deleted', { contentId: id, commentId: commentId });
		}
		
		console.log(`🗑️  已删除评论: ${commentId}, 原因: ${reason || '管理员删除'}`);
		
		res.json({
			success: true,
			data: {
				contentId: id,
				commentId: commentId,
				deleted: true
			},
			message: '评论已删除',
			timestamp: Date.now()
		});
		
	} catch (error) {
		console.error('删除评论失败:', error);
		res.status(500).json({
			success: false,
			message: '删除评论失败: ' + error.message
		});
	}
});

// v1: 获取AI内容评论列表
app.get('/api/v1/admin/ai-content/:id/comments', (req, res) => {
	try {
		const { id } = req.params;
		const page = parseInt(req.query.page) || 1;
		const pageSize = parseInt(req.query.pageSize) || 20;
		
		// 验证pageSize最大值
		if (pageSize > 100) {
			return res.status(400).json({
				success: false,
				message: 'pageSize最大值为100'
			});
		}
		
		// 查找AI内容
		const content = aiDebateContent.find(item => item.id === id);
		
		if (!content) {
			return res.status(404).json({
				success: false,
				message: 'AI内容不存在'
			});
		}
		
		// 获取评论列表（从 content.comments）
		let comments = [];
		if (content.comments && Array.isArray(content.comments)) {
			comments = content.comments;
		}
		
		// 按时间倒序排序（最新的在前）
		comments.sort((a, b) => {
			const timeA = a.timestamp || a.time || 0;
			const timeB = b.timestamp || b.time || 0;
			// 如果是时间戳，直接比较；如果是ISO字符串，转换为时间戳比较
			const tsA = typeof timeA === 'number' ? timeA : new Date(timeA).getTime();
			const tsB = typeof timeB === 'number' ? timeB : new Date(timeB).getTime();
			return tsB - tsA; // 降序
		});
		
		// 分页
		const total = comments.length;
		const start = (page - 1) * pageSize;
		const end = start + pageSize;
		const paginatedComments = comments.slice(start, end);
		
		// 转换为文档格式
		const formattedComments = paginatedComments.map(comment => {
			// 转换timestamp为ISO格式
			let timestampISO = '';
			if (comment.timestamp) {
				if (typeof comment.timestamp === 'number') {
					timestampISO = new Date(comment.timestamp).toISOString();
				} else {
					timestampISO = new Date(comment.timestamp).toISOString();
				}
			} else if (comment.time) {
				// 如果只有time字段（如"刚刚"、"3分钟前"），使用当前时间
				timestampISO = new Date().toISOString();
			} else {
				timestampISO = new Date().toISOString();
			}
			
			// 判断是否为匿名用户
			const userId = comment.userId || 
				(comment.user === '匿名用户' || !comment.user ? 'anonymous' : null) || 
				'anonymous';
			
			return {
				commentId: comment.commentId || comment.id || '',
				userId: userId,
				nickname: comment.nickname || comment.user || '匿名用户',
				avatar: comment.avatar || '👤',
				content: comment.content || comment.text || '',
				likes: comment.likes || 0,
				timestamp: timestampISO
			};
		});
		
		res.json({
			success: true,
			data: {
				contentId: id,
				contentText: content.content || content.text || '',
				total: total,
				page: page,
				pageSize: pageSize,
				comments: formattedComments
			}
		});
		
	} catch (error) {
		console.error('获取AI内容评论列表失败:', error);
		res.status(500).json({
			success: false,
			message: '获取评论列表失败: ' + error.message
		});
	}
});

// v1: 删除AI内容评论
app.delete('/api/v1/admin/ai-content/:id/comments/:commentId', (req, res) => {
	try {
		const { id, commentId } = req.params;
		const { reason = '', notifyUsers = true } = req.body;
		
		// 查找AI内容
		const content = aiDebateContent.find(item => item.id === id);
		
		if (!content) {
			return res.status(404).json({
				success: false,
				message: 'AI内容不存在'
			});
		}
		
		// 获取评论列表
		let comments = [];
		if (content.comments && Array.isArray(content.comments)) {
			comments = content.comments;
		}
		
		// 查找评论（支持commentId或id字段）
		const commentIndex = comments.findIndex(c => {
			const cId = c.commentId || c.id;
			return cId === commentId || String(cId) === String(commentId);
		});
		
		if (commentIndex === -1) {
			return res.status(404).json({
				success: false,
				message: `评论ID ${commentId} 不存在或不属于内容ID ${id}`
			});
		}
		
		// 删除评论
		const deletedComment = comments.splice(commentIndex, 1)[0];
		
		// 更新内容中的评论数组
		content.comments = comments;
		
		// 更新统计数据
		if (content.statistics) {
			content.statistics.comments = (content.statistics.comments || 0) - 1;
		} else {
			content.statistics = {
				views: (content.statistics && content.statistics.views) || 0,
				likes: (content.statistics && content.statistics.likes) || content.likes || 0,
				comments: comments.length
			};
		}
		
		// 如果通知用户，通过WebSocket广播删除通知
		if (notifyUsers) {
			broadcast('comment-deleted', {
				contentId: id,
				commentId: commentId,
				timestamp: Date.now()
			});
		}
		
		console.log(`🗑️  已删除评论: ${commentId}, 原因: ${reason || '管理员删除'}`);
		
		// 按照文档格式返回响应
		res.json({
			success: true,
			data: {
				commentId: commentId,
				contentId: id,
				deleteTime: null // 由前端填充当前时间
			},
			message: '评论已删除'
		});
		
	} catch (error) {
		console.error('删除评论失败:', error);
		res.status(500).json({
			success: false,
			message: '删除评论失败: ' + error.message
		});
	}
});

app.post('/api/admin/ai-content', (req, res) => {
	try {
		const { text, side, debate_id, streamId } = req.body;
		
		if (!text || !side) {
			return res.status(400).json({ error: '缺少必要参数: text, side' });
		}
		
		if (side !== 'left' && side !== 'right') {
			return res.status(400).json({ error: 'side 必须是 "left" 或 "right"' });
		}
		
		const newContent = {
			id: uuidv4(),
			debate_id: debate_id || debateTopic.id,
			text: text.trim(),
			side: side,
			timestamp: new Date().getTime(),
			comments: [],
			likes: 0,
			streamId: streamId || globalLiveStatus.streamId || null // 🔧 添加 streamId 字段
		};
		
		aiDebateContent.push(newContent);
		
		// 广播新内容添加
		broadcast('newAIContent', {
			...newContent,
			updatedBy: 'admin'
		});
		
		res.json({
			success: true,
			data: newContent
		});
	} catch (error) {
		res.status(500).json({ error: '添加 AI 内容失败' });
	}
});

app.put('/api/admin/ai-content/:id', (req, res) => {
	try {
		const { id } = req.params;
		const { text, side, debate_id } = req.body;
		
		const index = aiDebateContent.findIndex(item => item.id === id);
		if (index === -1) {
			return res.status(404).json({ error: '内容不存在' });
		}
		
		if (text !== undefined) {
			aiDebateContent[index].text = text.trim();
		}
		if (side !== undefined) {
			if (side !== 'left' && side !== 'right') {
				return res.status(400).json({ error: 'side 必须是 "left" 或 "right"' });
			}
			aiDebateContent[index].side = side;
		}
		if (debate_id !== undefined) {
			aiDebateContent[index].debate_id = debate_id;
		}
		
		// 广播内容更新
		broadcast('ai-content-updated', {
			content: aiDebateContent[index],
			updatedBy: 'admin'
		});
		
		res.json({
			success: true,
			data: aiDebateContent[index]
		});
	} catch (error) {
		res.status(500).json({ error: '更新 AI 内容失败' });
	}
});

app.delete('/api/admin/ai-content/:id', (req, res) => {
	try {
		const { id } = req.params;
		const index = aiDebateContent.findIndex(item => item.id === id);
		
		if (index === -1) {
			return res.status(404).json({ error: '内容不存在' });
		}
		
		const deletedContent = aiDebateContent.splice(index, 1)[0];
		
		// 广播内容删除
		broadcast('aiContentDeleted', {
			contentId: id,
			updatedBy: 'admin'
		});
		
		res.json({
			success: true,
			message: '删除成功',
			data: deletedContent
		});
	} catch (error) {
		res.status(500).json({ error: '删除 AI 内容失败' });
	}
});

// 通知大屏显示 AI 内容（纯模拟生成后调用，无需真实 AI 服务）
app.post('/api/admin/ai-content/notify-display', (req, res) => {
	try {
		const { streamId } = req.body || {};
		if (!streamId) {
			return res.status(400).json({ success: false, error: '缺少 streamId' });
		}
		if (!streamAIStatuses[streamId]) streamAIStatuses[streamId] = {};
		streamAIStatuses[streamId].status = 'running';
		broadcast('aiStatus', { status: 'running', streamId });
		res.json({ success: true, message: '已通知大屏显示 AI 内容' });
	} catch (e) {
		res.status(500).json({ success: false, error: e.message });
	}
});

// ==================== 后台管理 API 结束 ====================

// ==================== 统计 API（只读） ====================
app.get('/api/admin/statistics/summary', (req, res) => {
    try {
        const db = require(ADMIN_DB_PATH);
        const stats = db.statistics.get();
        const users = db.users.getAll();
        const streams = db.streams.getAll();
        const totalVotes = stats.totalVotes || 0;
        const totalUsers = users.length;
        const totalStreams = streams.length;
        const totalLiveDays = Array.isArray(stats.dailyStats) ? stats.dailyStats.length : 0;
        res.json({
            success: true,
            data: {
                totalVotes,
                totalUsers,
                totalStreams,
                totalLiveDays
            }
        });
    } catch (error) {
        res.status(500).json({ error: '获取统计汇总失败' });
    }
});

app.get('/api/admin/statistics/daily', (req, res) => {
    try {
        const db = require(ADMIN_DB_PATH);
        const stats = db.statistics.get();
        const daily = Array.isArray(stats.dailyStats) ? stats.dailyStats : [];
        res.json({ success: true, data: daily });
    } catch (error) {
        res.status(500).json({ error: '获取每日统计失败' });
    }
});

// 单条直播流每场正反方票累计到当日统计（供数据统计票数分析按日期查询）；直播完后根据当前数据更新并保存
function accumulateStreamVotesIntoDaily(streamId, leftVotes, rightVotes) {
	try {
		const db = require(ADMIN_DB_PATH);
		const todayStr = new Date().toISOString().slice(0, 10);
		const stats = db.statistics.get();
		const daily = Array.isArray(stats.dailyStats) ? stats.dailyStats : [];
		let dayRow = daily.find(d => d.date === todayStr);
		if (!dayRow) dayRow = { date: todayStr, totalVotes: 0, leftVotes: 0, rightVotes: 0, activeUsers: 0, streamVotesBar: [], hourlyActivity: null };
		const streamVotesBar = Array.isArray(dayRow.streamVotesBar) ? dayRow.streamVotesBar.slice() : [];
		const stream = db.streams.getById(streamId);
		const name = (stream && stream.name) ? stream.name : streamId;
		const idx = streamVotesBar.findIndex(s => s.id === streamId);
		if (idx >= 0) {
			streamVotesBar[idx].leftVotes = (streamVotesBar[idx].leftVotes || 0) + (leftVotes || 0);
			streamVotesBar[idx].rightVotes = (streamVotesBar[idx].rightVotes || 0) + (rightVotes || 0);
		} else {
			streamVotesBar.push({ id: streamId, name, leftVotes: leftVotes || 0, rightVotes: rightVotes || 0 });
		}
		const addLeft = leftVotes || 0;
		const addRight = rightVotes || 0;
		const newTotalVotes = (dayRow.totalVotes || 0) + addLeft + addRight;
		const newLeftVotes = (dayRow.leftVotes || 0) + addLeft;
		const newRightVotes = (dayRow.rightVotes || 0) + addRight;
		db.statistics.upsertDailyStat(todayStr, {
			totalVotes: newTotalVotes,
			leftVotes: newLeftVotes,
			rightVotes: newRightVotes,
			activeUsers: dayRow.activeUsers,
			streamVotesBar,
			hourlyActivity: dayRow.hourlyActivity
		});
		console.log('📊 票数分析已累加:', { streamId, name, leftVotes, rightVotes, date: todayStr });
	} catch (e) { /* ignore */ }
}

// 按“当日投票次数 > threshold”统计活跃用户数（数据统计页「活跃用户」）
// 使用本地日期：与历史次数里展示的时间一致，按每条投票记录的本地日期归类
function toLocalDateStr(d) {
    const x = new Date(d);
    const y = x.getFullYear();
    const m = String(x.getMonth() + 1).padStart(2, '0');
    const day = String(x.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}
function getActiveUsersCountByVoteThreshold(dateStr, threshold = 8) {
    const db = require(ADMIN_DB_PATH);
    const users = db.users.getAll();
    if (!Array.isArray(users)) return 0;
    let count = 0;
    for (const u of users) {
        const history = Array.isArray(u.voteHistory) ? u.voteHistory : [];
        const thatDay = history.filter(r => {
            if (!r || !r.at) return false;
            const recordDate = toLocalDateStr(r.at);
            return recordDate === dateStr;
        });
        if (thatDay.length > threshold) count += 1;
    }
    return count;
}

// 获取指定日期的活跃用户数（投票次数 > 8 视为活跃）；无 date 时用服务器本地“今天”
app.get('/api/admin/statistics/active-users', (req, res) => {
    try {
        const date = req.query.date || '';
        const dateStr = date ? date : toLocalDateStr(new Date());
        const activeUsers = getActiveUsersCountByVoteThreshold(dateStr, 8);
        res.json({ success: true, data: { activeUsers, date: dateStr } });
    } catch (error) {
        res.status(500).json({ success: false, error: '获取活跃用户失败' });
    }
});

// 按日期范围查询历史统计（数据统计页「日期查询」）；含柱状图、时段图持久化数据
app.get('/api/admin/statistics/range', (req, res) => {
    try {
        const db = require(ADMIN_DB_PATH);
        const from = req.query.from || '';
        const to = req.query.to || '';
        const stats = db.statistics.get();
        let daily = Array.isArray(stats.dailyStats) ? stats.dailyStats : [];

        const todayStr = new Date().toISOString().slice(0, 10);
        const votesAll = db.votes.getAll();
        const streamsAll = db.streams.getAll();
        const usersAll = db.users.getAll();

        const streamVotesBarToday = (streamsAll || []).map(s => {
            const v = (votesAll || {})[s.id] || {};
            return {
                id: s.id,
                name: s.name || s.id,
                leftVotes: v.leftVotes || 0,
                rightVotes: v.rightVotes || 0
            };
        });
        const existingToday = daily.find(d => d.date === todayStr);
        // 票数分析只由关播时 accumulateStreamVotesIntoDaily 累加，不在此处用本场当前票数覆盖
        let streamVotesBarToSave = (existingToday && Array.isArray(existingToday.streamVotesBar) && existingToday.streamVotesBar.length > 0)
            ? existingToday.streamVotesBar
            : [];
        const hourlyActivityToday = Array(24).fill(0);
        for (const u of usersAll || []) {
            const history = Array.isArray(u.voteHistory) ? u.voteHistory : [];
            for (const r of history) {
                if (!r || typeof r.at !== 'string' || r.at.slice(0, 10) !== todayStr) continue;
                const hour = parseInt(r.at.slice(11, 13), 10);
                if (hour >= 0 && hour < 24) hourlyActivityToday[hour] = (hourlyActivityToday[hour] || 0) + 1;
            }
        }
        const activeUsersToday = getActiveUsersCountByVoteThreshold(todayStr, 8);
        // 写入前再读一次当日 streamVotesBar，避免覆盖关播刚累加的数据（竞态）
        const statsLatest = db.statistics.get();
        const dailyLatest = Array.isArray(statsLatest.dailyStats) ? statsLatest.dailyStats : [];
        const existingTodayLatest = dailyLatest.find(d => d.date === todayStr);
        if (existingTodayLatest && Array.isArray(existingTodayLatest.streamVotesBar) && existingTodayLatest.streamVotesBar.length > 0) {
            streamVotesBarToSave = existingTodayLatest.streamVotesBar;
        }
        let totalVotesToday = 0, leftVotesToday = 0, rightVotesToday = 0;
        streamVotesBarToSave.forEach(s => {
            leftVotesToday += (s.leftVotes || 0);
            rightVotesToday += (s.rightVotes || 0);
        });
        totalVotesToday = leftVotesToday + rightVotesToday;
        db.statistics.upsertDailyStat(todayStr, {
            totalVotes: totalVotesToday,
            leftVotes: leftVotesToday,
            rightVotes: rightVotesToday,
            activeUsers: activeUsersToday,
            streamVotesBar: streamVotesBarToSave,
            hourlyActivity: hourlyActivityToday
        });
        daily = (db.statistics.get().dailyStats || []).slice();

        let totalVotes = 0, leftVotes = 0, rightVotes = 0, sumActiveUsers = 0;
        const dailyInRange = [];
        const fromDate = from ? new Date(from + 'T00:00:00') : null;
        const toDate = to ? new Date(to + 'T23:59:59') : null;
        daily.forEach(d => {
            const dDate = d.date ? new Date(d.date + 'T00:00:00') : null;
            if (dDate && fromDate && toDate && dDate >= fromDate && dDate <= toDate) {
                let activeUsers = d.activeUsers;
                if (activeUsers == null) activeUsers = getActiveUsersCountByVoteThreshold(d.date, 8);
                dailyInRange.push({
                    ...d,
                    activeUsers
                });
                totalVotes += (d.totalVotes || 0);
                leftVotes += (d.leftVotes || 0);
                rightVotes += (d.rightVotes || 0);
                sumActiveUsers += (activeUsers || 0);
            }
        });
        // 不选日期时按“今天”查：今日条目用当前票数合并，保证活跃用户/投票分布显示今日实时
        const todayDate = new Date(todayStr + 'T12:00:00');
        if (fromDate && toDate && todayDate >= fromDate && todayDate <= toDate) {
            const todayEntry = dailyInRange.find(d => d.date === todayStr);
            if (todayEntry) {
                let curLeft = 0, curRight = 0;
                (streamVotesBarToday || []).forEach(s => {
                    curLeft += (s.leftVotes || 0);
                    curRight += (s.rightVotes || 0);
                });
                todayEntry.leftVotes = curLeft;
                todayEntry.rightVotes = curRight;
                todayEntry.totalVotes = curLeft + curRight;
                todayEntry.streamVotesBar = streamVotesBarToday || [];
                todayEntry.activeUsers = activeUsersToday;
                totalVotes = 0;
                leftVotes = 0;
                rightVotes = 0;
                sumActiveUsers = 0;
                dailyInRange.forEach(d => {
                    totalVotes += (d.totalVotes || 0);
                    leftVotes += (d.leftVotes || 0);
                    rightVotes += (d.rightVotes || 0);
                    sumActiveUsers += (d.activeUsers || 0);
                });
            }
        }
        if (dailyInRange.length === 0 && (from || to)) {
            totalVotes = stats.totalVotes || 0;
            const votes = db.votes.getAll();
            Object.values(votes || {}).forEach(v => {
                leftVotes += (v.leftVotes || 0);
                rightVotes += (v.rightVotes || 0);
            });
        } else if (dailyInRange.length === 0) {
            totalVotes = stats.totalVotes || 0;
            const votes = db.votes.getAll();
            Object.values(votes || {}).forEach(v => {
                leftVotes += (v.leftVotes || 0);
                rightVotes += (v.rightVotes || 0);
            });
        }
        const totalUsers = (usersAll && usersAll.length) ? usersAll.length : 0;
        const maxActiveUsers = dailyInRange.length
            ? Math.max(...dailyInRange.map(d => (d.activeUsers != null ? d.activeUsers : 0)))
            : 0;
        res.json({
            success: true,
            data: {
                totalVotes,
                leftVotes,
                rightVotes,
                activeUsers: sumActiveUsers,
                totalUsers,
                maxActiveUsers,
                dailyStats: dailyInRange,
                from: from || null,
                to: to || null
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: '获取区间统计失败' });
    }
});

// 添加请求日志中间件（调试用）
app.use((req, res, next) => {
	if (req.path.startsWith('/api')) {
		console.log(`📥 API请求: ${req.method} ${req.path}`);
	}
	next();
});

// 静态文件服务（提供静态资源，如需要）
// 注意：uni-app 小程序项目通常不需要在服务器提供前端静态文件
// 如果需要提供构建后的静态文件，可以取消注释并配置正确路径
// app.use(express.static(path.join(__dirname, 'dist')));

// 注意：代理中间件已移动到所有本地路由之后（见 server.js 末尾，在 404 处理器之前）


// ==================== 投票数据（按直播流分别统计，持久化到 data/votes.json）====================
const votesByStream = Object.create(null);
const USER_VOTES_PER_ACTION = 2;   // 普通用户 1 次投票 = 2 票，全投同一阵营
const JUDGE_VOTES_PER_ACTION = 10; // 评委 1 次投票 = 10 票，全投同一阵营

function getVotesState(streamId) {
	if (!streamId) return { leftVotes: 0, rightVotes: 0 };
	if (!votesByStream[streamId]) {
		try {
			const dbV = require(ADMIN_DB_PATH).votes.get(streamId);
			votesByStream[streamId] = { leftVotes: dbV.leftVotes || 0, rightVotes: dbV.rightVotes || 0 };
		} catch (e) {
			votesByStream[streamId] = { leftVotes: 0, rightVotes: 0 };
		}
	}
	return votesByStream[streamId];
}

function setVotesState(streamId, leftVotes, rightVotes) {
	const s = getVotesState(streamId);
	s.leftVotes = Math.max(0, parseInt(leftVotes, 10) || 0);
	s.rightVotes = Math.max(0, parseInt(rightVotes, 10) || 0);
	try {
		require(ADMIN_DB_PATH).votes.set(streamId, s.leftVotes, s.rightVotes);
	} catch (e) { /* ignore */ }
	return s;
}

function addVotesState(streamId, leftDelta, rightDelta) {
	const s = getVotesState(streamId);
	s.leftVotes = Math.max(0, s.leftVotes + (parseInt(leftDelta, 10) || 0));
	s.rightVotes = Math.max(0, s.rightVotes + (parseInt(rightDelta, 10) || 0));
	try {
		require(ADMIN_DB_PATH).votes.set(streamId, s.leftVotes, s.rightVotes);
	} catch (e) { /* ignore */ }
	return s;
}

// 本场票数：仅开播后真实投票累加，不受票数管理「当前票数」手动修改影响；大屏展示用
const liveSessionVotesByStream = Object.create(null);
function getLiveSessionVotes(streamId) {
	if (!streamId) return { leftVotes: 0, rightVotes: 0 };
	if (!liveSessionVotesByStream[streamId]) return { leftVotes: 0, rightVotes: 0 };
	return liveSessionVotesByStream[streamId];
}
function addLiveSessionVotes(streamId, leftDelta, rightDelta) {
	const st = streamLiveStatuses[streamId];
	const isMockLive = mockLiveStreamIds && mockLiveStreamIds.has(streamId);
	if ((!st || !st.isLive) && !isMockLive) return;
	if (!liveSessionVotesByStream[streamId]) liveSessionVotesByStream[streamId] = { leftVotes: 0, rightVotes: 0 };
	const s = liveSessionVotesByStream[streamId];
	s.leftVotes = Math.max(0, s.leftVotes + (parseInt(leftDelta, 10) || 0));
	s.rightVotes = Math.max(0, s.rightVotes + (parseInt(rightDelta, 10) || 0));
}

function initLiveSessionVotesForStream(streamId) {
	if (!streamId) return;
	liveSessionVotesByStream[streamId] = { leftVotes: 0, rightVotes: 0 };
}

// 票比接口：只读本场票数，初始 0，不读当前票数/历史；未直播一律 0:0
app.get('/api/v1/display/vote-ratio', (req, res) => {
	try {
		let sid = req.query.stream_id || req.query['stream id'] || null;
		if (!sid) {
			try {
				const db = require(ADMIN_DB_PATH);
				if (db.streams && db.streams.getActive) {
					const active = db.streams.getActive();
					if (active && active.id) sid = active.id;
				}
				if (!sid && db.streams && db.streams.getAll) {
					const all = db.streams.getAll();
					if (Array.isArray(all) && all[0] && all[0].id) sid = all[0].id;
				}
			} catch (e) { /* ignore */ }
		}
		const streamStatus = sid ? (streamLiveStatuses[sid] || { isLive: false }) : { isLive: false };
		const isLive = !!(sid && (streamStatus.isLive || (mockLiveStreamIds && mockLiveStreamIds.has(sid))));
		const v = isLive ? getLiveSessionVotes(sid) : { leftVotes: 0, rightVotes: 0 };
		const leftVotes = Number(v.leftVotes) || 0;
		const rightVotes = Number(v.rightVotes) || 0;
		const totalVotes = leftVotes + rightVotes;
		const leftPercentage = totalVotes > 0 ? Math.round((leftVotes / totalVotes) * 100) : 50;
		const rightPercentage = totalVotes > 0 ? Math.round((rightVotes / totalVotes) * 100) : 50;
		res.json({
			success: true,
			data: {
				streamId: sid,
				leftVotes,
				rightVotes,
				totalVotes,
				leftPercentage,
				rightPercentage
			}
		});
	} catch (e) {
		console.error('display vote-ratio 失败:', e);
		res.status(500).json({ success: false, message: e.message });
	}
});

function getAllVotesTotal() {
	return Object.values(votesByStream).reduce((sum, v) => sum + (v.leftVotes || 0) + (v.rightVotes || 0), 0);
}

// 单场投票上限：评委票数*3 + 2*(在线人数-3)，直播票数不得高于此值
function getVoteCeiling(streamId) {
	const online = streamOnlineCounts[streamId] || 0;
	return 30 + 2 * Math.max(0, online - 3); // 评委3人各10票=30，其余每人最多2票
}

function capVotesToCeiling(streamId, s) {
	const total = (s.leftVotes || 0) + (s.rightVotes || 0);
	const cap = getVoteCeiling(streamId);
	if (total <= cap) return;
	const ratio = total > 0 ? cap / total : 0;
	s.leftVotes = Math.floor((s.leftVotes || 0) * ratio);
	s.rightVotes = cap - s.leftVotes;
}

// 辩题信息
const debateTopic = {
    id: 'debate-default-001', // 辩题ID，用于标识该辩题
    title: "如果有一个能一键消除痛苦的按钮，你会按吗？",
    description: "这是一个关于痛苦、成长与人性选择的深度辩论"
};

// AI智能识别的辩论内容
const aiDebateContent = [
    {
        id: uuidv4(),
        debate_id: debateTopic.id, // 标识该观点属于哪个辩题
        text: "正方观点：痛苦是人生成长的必要经历，消除痛苦会让我们失去学习和成长的机会。",
        side: "left",
        timestamp: new Date().getTime() - 300000, // 5分钟前
        comments: [
            {
                id: uuidv4(),
                user: "心理学家",
                text: "痛苦确实能促进心理成长，但过度的痛苦也可能造成创伤",
                time: "3分钟前",
                avatar: "🧠",
                likes: 15
            },
            {
                id: uuidv4(),
                user: "哲学家",
                text: "尼采说过，那些杀不死我们的，会让我们更强大",
                time: "4分钟前",
                avatar: "🤔",
                likes: 23
            }
        ],
        likes: 45
    },
    {
        id: uuidv4(),
        debate_id: debateTopic.id, // 标识该观点属于哪个辩题
        text: "反方观点：如果能够消除痛苦，为什么不呢？痛苦本身没有价值，消除痛苦可以让人更专注于积极的事情。",
        side: "right",
        timestamp: new Date().getTime() - 240000, // 4分钟前
        comments: [
            {
                id: uuidv4(),
                user: "医生",
                text: "作为医生，我见过太多不必要的痛苦，如果能消除，我支持",
                time: "2分钟前",
                avatar: "👨‍⚕️",
                likes: 18
            },
            {
                id: uuidv4(),
                user: "患者家属",
                text: "看着亲人痛苦，我多么希望有这样的按钮",
                time: "3分钟前",
                avatar: "💝",
                likes: 31
            }
        ],
        likes: 52
    },
    {
        id: uuidv4(),
        debate_id: debateTopic.id, // 标识该观点属于哪个辩题
        text: "正方回应：痛苦让我们学会同理心，如果所有人都没有痛苦经历，我们如何理解他人的苦难？",
        side: "left",
        timestamp: new Date().getTime() - 180000, // 3分钟前
        comments: [
            {
                id: uuidv4(),
                user: "社工",
                text: "同理心确实需要痛苦的经历来培养",
                time: "1分钟前",
                avatar: "🤝",
                likes: 12
            },
            {
                id: uuidv4(),
                user: "作家",
                text: "很多伟大的文学作品都源于作者的痛苦经历",
                time: "2分钟前",
                avatar: "📚",
                likes: 19
            }
        ],
        likes: 38
    },
    {
        id: uuidv4(),
        debate_id: debateTopic.id, // 标识该观点属于哪个辩题
        text: "反方回应：我们可以通过其他方式培养同理心，比如阅读、教育。消除痛苦不等于消除所有负面情绪。",
        side: "right",
        timestamp: new Date().getTime() - 120000, // 2分钟前
        comments: [
            {
                id: uuidv4(),
                user: "教育工作者",
                text: "教育确实可以培养同理心，不一定需要亲身经历痛苦",
                time: "1分钟前",
                avatar: "👩‍🏫",
                likes: 16
            },
            {
                id: uuidv4(),
                user: "心理咨询师",
                text: "区分痛苦和负面情绪很重要，这个按钮可能只针对真正的痛苦",
                time: "刚刚",
                avatar: "💭",
                likes: 8
            }
        ],
        likes: 41
    },
    {
        id: uuidv4(),
        debate_id: debateTopic.id, // 标识该观点属于哪个辩题
        text: "正方总结：痛苦是人性的一部分，消除痛苦可能会让我们失去作为人的完整性。",
        side: "left",
        timestamp: new Date().getTime() - 60000, // 1分钟前
        comments: [
            {
                id: uuidv4(),
                user: "神学家",
                text: "痛苦在宗教和哲学中都有其深层意义",
                time: "刚刚",
                avatar: "⛪",
                likes: 14
            }
        ],
        likes: 29
    }
];

// 动态随机投票与在线人数波动（直播中每 3-5 秒随机一人投票，每 5-8 秒在线人数 ±1-3）
function simulateVoteChanges() {
	setInterval(() => doDynamicRandomVote(), 3000 + Math.floor(Math.random() * 2000));
	setInterval(() => doOnlineCountFluctuation(), 8000 + Math.floor(Math.random() * 4000)); // 每 8-12 秒波动
	console.log('✅ 动态投票(3-5s)与在线人数波动(5-8s)已启动');
}

// 模拟AI识别新内容
function simulateNewAIContent() {
    const newContents = [
        {
            text: "正方补充：痛苦让我们珍惜快乐，没有对比就没有真正的幸福。",
            side: "left"
        },
        {
            text: "反方补充：现代医学已经在消除很多痛苦，这个按钮只是技术的延伸。",
            side: "right"
        },
        {
            text: "正方质疑：如果所有人都按这个按钮，社会会变成什么样？",
            side: "left"
        },
        {
            text: "反方回应：每个人都有自己的选择权，不应该强迫别人承受痛苦。",
            side: "right"
        }
    ];
    
    setInterval(() => {
        // 任一流的AI在运行则模拟AI内容
        const anyAI = Object.values(streamAIStatuses).some(s => s && s.status === 'running') || globalAIStatus.status === 'running';
        if (!anyAI) return;
        const randomContent = newContents[Math.floor(Math.random() * newContents.length)];
        const newContent = {
            id: uuidv4(), // 使用UUID
            debate_id: debateTopic.id, // 标识该观点属于哪个辩题
            text: randomContent.text,
            side: randomContent.side,
            timestamp: new Date().getTime(),
            comments: [],
            likes: Math.floor(Math.random() * 20) + 10,
            streamId: globalLiveStatus.streamId || null // 🔧 添加 streamId 字段
        };
        
        aiDebateContent.push(newContent);
        console.log(`新增AI内容: ${newContent.text} (streamId: ${newContent.streamId})`);
    }, 15000); // 每15秒添加新内容
}

// 根据流程环节纯模拟生成辩论内容（与 admin-events.js 规则一致）
function generateMockContentFromSegments(segments) {
	if (!Array.isArray(segments) || segments.length === 0) return [];
	const charsPerSecond = 3.5;
	const leftTemplates = [
		'我方认为，这一观点恰恰忽视了现实中的复杂性。从数据来看，正方所举的例子并不具有普遍性。',
		'正如前面所述，正方的逻辑存在明显漏洞。我们更需要关注的是长期影响而非短期效果。',
		'从伦理与法律角度，我方坚持认为这一做法将带来不可逆的后果，必须慎重考量。'
	];
	const rightTemplates = [
		'反方所担心的情形在实际操作中可以通过制度设计来规避，我们不应因噎废食。',
		'大量案例表明，反方的担忧更多是理论上的，在实践中已有成熟方案可以应对。',
		'我方再次强调，问题的核心在于如何平衡各方利益，而非简单地否定一种可能性。'
	];
	const hostTemplates = [
		'感谢双方发言。接下来进入下一环节，请双方紧扣辩题展开论述。',
		'时间到。有请下一环节的辩手做好准备。',
		'感谢以上陈述。本环节结束，我们进入自由辩论阶段。'
	];
	function repeatToLength(str, targetLen) {
		if (!str || targetLen <= 0) return '';
		if (str.length >= targetLen) return str.slice(0, targetLen);
		let out = str;
		while (out.length < targetLen) out += str;
		return out.slice(0, targetLen);
	}
	function pick(arr, seed) {
		return arr[Math.abs(seed) % arr.length];
	}
	const result = [];
	let seed = 0;
	for (const seg of segments) {
		const duration = Math.max(10, parseInt(seg.duration, 10) || 180);
		const targetChars = Math.round(duration * (charsPerSecond + (Math.random() * 0.5)));
		const side = (seg.side === 'right' ? 'right' : seg.side === 'left' ? 'left' : 'both');
		const name = (seg.name || '').trim() || '环节';
		if (side === 'both') {
			const count = Math.max(4, Math.min(12, Math.floor(targetChars / 40)));
			const perLen = Math.max(20, Math.floor(targetChars / count));
			for (let i = 0; i < count; i++) {
				const isLeft = i % 2 === 0;
				const tpl = isLeft ? pick(leftTemplates, seed++) : pick(rightTemplates, seed++);
				result.push({ text: repeatToLength(tpl, perLen), side: isLeft ? 'left' : 'right' });
			}
		} else if (name.indexOf('主持') >= 0 || name.indexOf('串词') >= 0 || name.indexOf('开场') >= 0) {
			const tpl = pick(hostTemplates, seed++);
			result.push({ text: repeatToLength(tpl, targetChars), side: 'left' });
		} else {
			const tpl = side === 'left' ? pick(leftTemplates, seed++) : pick(rightTemplates, seed++);
			result.push({ text: repeatToLength(tpl, targetChars), side: side });
		}
	}
	return result;
}

const DEFAULT_SEGMENTS = [
	{ name: '正方发言', duration: 180, side: 'left' },
	{ name: '反方质问', duration: 120, side: 'right' },
	{ name: '反方发言', duration: 180, side: 'right' },
	{ name: '正方质问', duration: 120, side: 'left' },
	{ name: '自由辩论', duration: 300, side: 'both' },
	{ name: '正方总结', duration: 120, side: 'left' },
	{ name: '反方总结', duration: 120, side: 'right' }
];

// 为所有辩题批量生成 AI 内容
app.post('/api/admin/ai-content/generate-all', (req, res) => {
	try {
		const dbLocal = require(ADMIN_DB_PATH);
		const streams = dbLocal.streams.getAll();
		if (!streams || streams.length === 0) {
			return res.json({ success: true, message: '暂无辩题', generated: {} });
		}
		const generatedByStream = {};
		for (const stream of streams) {
			const streamId = stream.id;
			const flow = dbLocal.debateFlows.get(streamId);
			const segments = (flow && flow.segments && flow.segments.length > 0) ? flow.segments : DEFAULT_SEGMENTS;
			const items = generateMockContentFromSegments(segments);
			for (const item of items) {
				const newContent = {
					id: uuidv4(),
					debate_id: streamId,
					text: item.text.trim(),
					side: item.side,
					timestamp: Date.now(),
					comments: [],
					likes: 0,
					streamId: streamId
				};
				aiDebateContent.push(newContent);
				broadcast('newAIContent', { ...newContent, updatedBy: 'admin' });
			}
			generatedByStream[streamId] = { name: stream.name, count: items.length };
			if (!streamAIStatuses[streamId]) streamAIStatuses[streamId] = {};
			streamAIStatuses[streamId].status = 'running';
			broadcast('aiStatus', { status: 'running', streamId });
		}
		console.log('✅ 已为所有辩题生成 AI 内容:', generatedByStream);
		res.json({ success: true, message: '已为所有辩题生成 AI 内容', generated: generatedByStream });
	} catch (e) {
		console.error('批量生成 AI 内容失败:', e);
		res.status(500).json({ success: false, error: e.message });
	}
});

// API路由

// 获取当前票数
app.get('/api/votes', (req, res) => {
    try {
		const sid = req.query.stream_id || (globalLiveStatus && globalLiveStatus.streamId) || null;
		const v = sid ? getVotesState(sid) : { leftVotes: 0, rightVotes: 0 };
        const totalVotes = (v.leftVotes || 0) + (v.rightVotes || 0);
        res.json({
            success: true,
            data: {
				streamId: sid,
                leftVotes: v.leftVotes,
                rightVotes: v.rightVotes,
                totalVotes: totalVotes,
                leftPercentage: totalVotes > 0
                    ? Math.round((v.leftVotes / totalVotes) * 100)
                    : 50,
                rightPercentage: totalVotes > 0
                    ? Math.round((v.rightVotes / totalVotes) * 100)
                    : 50
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: "获取票数时出错: " + error.message
        });
    }
});

// 获取辩题信息
app.get('/api/debate-topic', (req, res) => {
    try {
        // 确保返回的辩题信息包含 id 字段
        res.json({
            success: true,
            data: {
                id: debateTopic.id,
                title: debateTopic.title,
                description: debateTopic.description
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: "获取辩题时出错: " + error.message
        });
    }
});

// 获取AI识别内容（大屏用；支持 stream_id 过滤，只返回该辩题的内容）
app.get('/api/ai-content', (req, res) => {
    try {
        const streamId = req.query.stream_id || null;
        let list = aiDebateContent;
        if (streamId) {
            list = aiDebateContent.filter(item => !item.streamId || item.streamId === streamId);
        }
        res.json({
            success: true,
            data: list
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: "获取AI内容时出错: " + error.message
        });
    }
});

// 添加评论
app.post('/api/comment', (req, res) => {
    const { contentId, user, text, avatar } = req.body;

    // 参数验证
    if (!contentId || !text) {
        return res.status(400).json({
            success: false,
            message: "缺少必要参数: contentId 和 text"
        });
    }

    if (typeof text !== 'string' || text.trim().length === 0) {
        return res.status(400).json({
            success: false,
            message: "评论内容不能为空"
        });
    }

    const content = aiDebateContent.find(item => item.id === String(contentId));
    if (content) {
        // 使用UUID生成唯一的评论ID
        const newComment = {
            id: uuidv4(),
            user: user || "匿名用户",
            text: text.trim(),
            time: "刚刚",
            avatar: avatar || "👤",
            likes: 0
        };

        content.comments.push(newComment);

        res.json({
            success: true,
            data: newComment
        });
    } else {
        res.status(404).json({
            success: false,
            message: "内容不存在"
        });
    }
});

// 删除评论
app.delete('/api/comment/:commentId', (req, res) => {
    const { commentId } = req.params;
    const { contentId } = req.body;

    // 参数验证
    if (!commentId || !contentId) {
        return res.status(400).json({
            success: false,
            message: "缺少必要参数: commentId 和 contentId"
        });
    }

    const content = aiDebateContent.find(item => item.id === String(contentId));
    if (!content) {
        return res.status(404).json({
            success: false,
            message: "内容不存在"
        });
    }

    const commentIndex = content.comments.findIndex(c => c.id === String(commentId));
    if (commentIndex === -1) {
        return res.status(404).json({
            success: false,
            message: "评论不存在"
        });
    }

    // 删除评论
    const deletedComment = content.comments.splice(commentIndex, 1)[0];

    res.json({
        success: true,
        data: {
            message: "评论删除成功",
            deletedComment: deletedComment
        }
    });
});

// 点赞
app.post('/api/like', (req, res) => {
    console.log('✅ /api/like 路由被调用');
    console.log('📥 请求参数:', { contentId: req.body.contentId, commentId: req.body.commentId });
    const { contentId, commentId } = req.body;

    // 参数验证
    if (!contentId) {
        return res.status(400).json({
            success: false,
            message: "缺少必要参数: contentId"
        });
    }

    const content = aiDebateContent.find(item => item.id === contentId);
    if (content) {
        if (commentId !== undefined && commentId !== null) {
            // 评论点赞
            const comment = content.comments.find(c => c.id === commentId);
            if (comment) {
                comment.likes += 1;
                res.json({
                    success: true,
                    data: { likes: comment.likes }
                });
            } else {
                res.status(404).json({
                    success: false,
                    message: "评论不存在"
                });
            }
        } else {
            // 内容点赞
            content.likes += 1;
            res.json({
                success: true,
                data: { likes: content.likes }
            });
        }
    } else {
        res.status(404).json({
            success: false,
            message: "内容不存在"
        });
    }
});

// ==================== 微信登录辅助函数 ====================

/**
 * 调用微信API获取openid和session_key
 * @param {string} appid - 微信小程序AppID
 * @param {string} secret - 微信小程序AppSecret
 * @param {string} code - 微信登录code
 * @returns {Promise<Object>} 微信API响应数据
 */
function callWechatAPI(appid, secret, code) {
    return new Promise((resolve, reject) => {
        const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${appid}&secret=${secret}&js_code=${code}&grant_type=authorization_code`;
        
        https.get(url, (res) => {
            let data = '';
            
            res.on('data', (chunk) => {
                data += chunk;
            });
            
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    resolve(result);
                } catch (error) {
                    reject(new Error('解析微信API响应失败: ' + error.message));
                }
            });
        }).on('error', (error) => {
            reject(new Error('调用微信API失败: ' + error.message));
        });
    });
}

// 微信配置（从统一配置文件获取）
const WECHAT_CONFIG = {
    appid: currentConfig.wechat.appid,
    secret: process.env.WECHAT_SECRET || currentConfig.wechat.secret,
    useMock: currentConfig.wechat.useMock
};

// 微信登录接口
app.post('/api/wechat-login', async (req, res) => {
    const { code, userInfo, encryptedData, iv } = req.body;

    // 参数验证
    if (!code) {
        return res.status(400).json({
            success: false,
            message: "缺少必要参数: code"
        });
    }

    try {
        console.log('═══════════════════════════════════════');
        console.log('微信登录请求收到');
        console.log('═══════════════════════════════════════');
        console.log('Code:', code);
        console.log('UserInfo:', userInfo && userInfo.nickName);
        console.log('useMock 配置:', WECHAT_CONFIG.useMock);
        console.log('═══════════════════════════════════════');
        
        let wechatData = null;
        
        // 根据配置决定使用模拟模式还是真实微信API
        if (WECHAT_CONFIG.useMock) {
            // 使用模拟模式（用于开发测试或 H5 环境）
            console.log('✅ 使用模拟微信登录响应（开发模式）');
            
            // 模拟微信API响应
            wechatData = {
                openid: 'mock_openid_' + Date.now(),
                session_key: 'mock_session_key_' + Math.random().toString(36).substr(2, 9),
                // 注意：真实API不会返回unionid，除非用户已绑定开放平台
            };
            
            console.log('模拟数据生成成功:', {
                openid: wechatData.openid,
                session_key: wechatData.session_key.substring(0, 10) + '...'
            });
        } else {
            // 使用真实微信API
            console.log('🌐 调用真实微信登录API');
            console.log('AppID:', WECHAT_CONFIG.appid);
            
            try {
                console.log('📋 微信登录配置信息:');
                console.log('  - AppID:', WECHAT_CONFIG.appid);
                console.log('  - Secret:', WECHAT_CONFIG.secret ? WECHAT_CONFIG.secret.substring(0, 8) + '...' : '未设置');
                console.log('  - Code:', code ? code.substring(0, 20) + '...' : '未提供');
                
                const apiResult = await callWechatAPI(WECHAT_CONFIG.appid, WECHAT_CONFIG.secret, code);
                
                // 检查微信API返回的错误
                if (apiResult.errcode) {
                    console.error('❌ 微信API返回错误:');
                    console.error('  - 错误码:', apiResult.errcode);
                    console.error('  - 错误信息:', apiResult.errmsg);
                    console.error('  - 完整响应:', JSON.stringify(apiResult, null, 2));
                    
                    // 特殊处理常见错误
                    let errorMessage = `微信API错误: ${apiResult.errmsg || '未知错误'}, rid: ${apiResult.errcode || 'N/A'}`;
                    if (apiResult.errcode === 40029) {
                        errorMessage = '微信API错误: invalid code (code无效或已过期), rid: ' + apiResult.errcode;
                    } else if (apiResult.errcode === 40163) {
                        errorMessage = '微信API错误: code been used (code已被使用), rid: ' + apiResult.errcode;
                    }
                    
                    return res.status(400).json({
                        success: false,
                        message: errorMessage
                    });
                }
                
                // 成功获取微信数据
                wechatData = {
                    openid: apiResult.openid,
                    session_key: apiResult.session_key,
                    unionid: apiResult.unionid || null
                };
                
                console.log('真实微信API调用成功:', {
                    openid: wechatData.openid,
                    hasSessionKey: !!wechatData.session_key,
                    hasUnionId: !!wechatData.unionid
                });
            } catch (error) {
                console.error('调用真实微信API失败:', error);
                return res.status(500).json({
                    success: false,
                    message: `调用微信API失败: ${error.message}`
                });
            }
        }
        
        // 保存用户到数据库（在管理系统中显示）
        const db = require(ADMIN_DB_PATH);
        const userId = wechatData.openid; // 使用openid作为用户ID
        if (userId) {
            db.users.createOrUpdate({
                id: userId,
                nickName: (userInfo && userInfo.nickName) || '微信用户',
                avatarUrl: (userInfo && userInfo.avatarUrl) || '/static/logo.png'
            });
        }
        
        // 返回统一的响应格式
        const response = {
            success: true,
            data: {
                openid: wechatData.openid,
                session_key: wechatData.session_key,
                unionid: wechatData.unionid || null, // 如果有开放平台，会返回unionid
                userInfo: userInfo || {
                    nickName: '微信用户',
                    avatarUrl: '/static/logo.png'
                },
                loginTime: new Date().toISOString(),
                isMock: WECHAT_CONFIG.useMock || WECHAT_CONFIG.secret === 'YOUR_APP_SECRET_HERE'
            }
        };
        
        console.log('返回登录响应:', { 
            openid: response.data.openid,
            hasUserInfo: !!userInfo,
            isMock: response.data.isMock
        });
        
        res.json(response);
        
    } catch (error) {
        console.error('微信登录处理错误:', error);
        res.status(500).json({
            success: false,
            message: "服务器处理微信登录时出错: " + error.message
        });
    }
});

// 用户投票（统一规则）
// 投票规则：
// - 普通用户：每场直播仅1次投票行为，1次=2票，全投正方或全投反方；历史投票次数+1
// - 单场票数 = 用户投票次数×2 + 3位评委各10票
// - 全局总票数 = 所有场次(用户投票次数×2) + 所有场次评委票数
function handleUserVote(req, res) {
    console.log('═══════════════════════════════════════');
    console.log('✅ 用户投票接口被调用');
    console.log('📥 请求来源:', req.headers.origin || req.headers.referer || '未知');
    console.log('📥 请求方法:', req.method);
    console.log('📥 原始请求体:', req.body);
    console.log('📥 请求头:', {
        'content-type': req.headers['content-type'],
        'user-agent': (req.headers['user-agent'] && req.headers['user-agent'].substring(0, 50)) + '...'
    });
    console.log('═══════════════════════════════════════');
    
    // 兼容两种请求格式：
    // 格式1（直接）: { side, votes, leftVotes, rightVotes, userId }
    // 格式2（包装）: { request: { side, votes, leftVotes, rightVotes, userId, streamId, stream_id } }
    let requestData = req.body;
    if (req.body.request) {
        // 如果使用了 request 包装格式，解包数据
        requestData = req.body.request;
    }
    
    const { side, userId, streamId, stream_id } = requestData;

	// 新规则：
	// - 一个用户 2 票，但只有 1 次投票机会（每个直播流每次开播计 1 次）
	// - 投票窗口：直播开始后 45s ~ 60s 内允许投票
	const sid = (streamId || stream_id || '').toString().trim();
	if (!sid) {
		return res.status(400).json({ success: false, message: 'streamId 必填' });
	}
	if (!userId) {
		return res.status(400).json({ success: false, message: 'userId 必填' });
	}
	if (side !== 'left' && side !== 'right') {
		return res.status(400).json({ success: false, message: "side 必须为 'left' 或 'right'" });
	}

	// 仅禁用用户不能投票（评委被选用时可看可投，被替换后才 banned）
	try {
		const db = require(ADMIN_DB_PATH);
		const u = db.users.getById(userId);
		if (u && u.status === 'banned') {
			return res.status(403).json({ success: false, message: '你已被禁用，无法投票' });
		}
	} catch (e) { /* ignore */ }

	const st = streamLiveStatuses[sid];
	if (!st || !st.isLive || !st.startTime) {
		return res.status(409).json({ success: false, message: '该直播流未在直播，无法投票' });
	}
	const liveId = st.liveId;
	const startMs = new Date(st.startTime).getTime();
	const nowMs = Date.now();
	const elapsedSec = Math.floor((nowMs - startMs) / 1000);

	if (elapsedSec < 45) {
		return res.status(403).json({ success: false, message: '投票尚未开始（直播 45 秒后开放投票）' });
	}
	if (elapsedSec > 60) {
		// 超时：自动关播（兜底）
		try { stopStreamLiveInternal(sid, 'vote-window-ended'); } catch (e) {}
		return res.status(403).json({ success: false, message: '投票已结束（直播 60 秒后自动关闭）' });
	}

	const sessionKey = `${sid}:${liveId}`;
	if (!voteSessions.has(sessionKey)) {
		voteSessions.set(sessionKey, { votedUsers: new Set(), judgesVoted: new Set() });
	}
	const sess = voteSessions.get(sessionKey);
	if (sess.votedUsers.has(userId)) {
		return res.status(409).json({ success: false, message: '你已投过票（每人只有一次投票机会）' });
	}
	sess.votedUsers.add(userId);

	// 用户每次固定 2 票，且只能投一方
	const userVotes = 2;
	if (side === 'left') {
		addVotesState(sid, userVotes, 0);
		addLiveSessionVotes(sid, userVotes, 0);
	} else {
		addVotesState(sid, 0, userVotes);
		addLiveSessionVotes(sid, 0, userVotes);
	}

	// 记录投票历史（用于“历史投票次数/详情”）
	try {
		const db = require(ADMIN_DB_PATH);
		db.users.appendVoteRecord(userId, {
			streamId: sid,
			liveId,
			side,
			votes: userVotes,
			at: new Date().toISOString()
		});
		db.statistics.incrementVotes(userVotes);
	} catch (e) { /* ignore */ }

	const v = getVotesState(sid);
	const total = (v.leftVotes || 0) + (v.rightVotes || 0);
	const responseData = {
		success: true,
		data: {
			streamId: sid,
			leftVotes: v.leftVotes,
			rightVotes: v.rightVotes,
			totalVotes: total,
			allTotalVotes: getAllVotesTotal(),
			leftPercentage: total > 0 ? Math.round((v.leftVotes / total) * 100) : 50,
			rightPercentage: total > 0 ? Math.round((v.rightVotes / total) * 100) : 50
		},
		message: '投票成功（每人2票）'
	};

	// 广播投票更新（带 streamId；大屏/卡片直播中用本场票数 liveSession*，票数管理用 left/right）
	const payload = {
		streamId: sid,
		leftVotes: v.leftVotes,
		rightVotes: v.rightVotes,
		totalVotes: total,
		allTotalVotes: getAllVotesTotal(),
		source: 'user',
		userVote: { userId, side, votes: userVotes },
		timestamp: new Date().toISOString()
	};
	if (st && st.isLive) {
		const sessionV = getLiveSessionVotes(sid);
		payload.liveSessionLeft = sessionV.leftVotes;
		payload.liveSessionRight = sessionV.rightVotes;
	}
	broadcast('votes-updated', payload);

	res.json(responseData);
}

// 路由定义：支持 /api/user-vote 和 /api/v1/user-vote 两种路径
app.post('/api/user-vote', handleUserVote);
app.post('/api/v1/user-vote', handleUserVote);

// ==================== 模拟投票 ====================
// 数据一致性公式：
// - 普通用户：1次投票行为=2票，历史投票次数+1（非+2）
// - 评委：3位评委各10票
// - 单场票数 = 用户投票次数×2 + 评委30票
// - 全局总票数 = Σ(各场用户投票次数×2) + Σ(各场评委票数)
function simulateMockVotes(streamId, liveId, sessionKey) {
	const st = streamLiveStatuses[streamId];
	if (!st || !st.isLive || st.liveId !== liveId) return;
	const sess = voteSessions.get(sessionKey);
	if (!sess) return;

	const db = require(ADMIN_DB_PATH);
	const USER_VOTES_PER_ACTION = 2;  // 普通用户 1 次投票 = 2 票
	const JUDGE_VOTES_DEFAULT = 10;   // 评委默认 10 票（未在评委页修改时）

	// 1. 评委投票：每位评委只能投给一方，票数取评委页设置或默认 10
	const judgeCfg = db.judges.get ? db.judges.get(streamId) : null;
	const judgeList = (judgeCfg && Array.isArray(judgeCfg.judges)) ? judgeCfg.judges : [];
	const judgeUserIds = judgeList
		.map(j => j.userId || (j.id === 'judge-1' ? 'judge-user-1' : j.id === 'judge-2' ? 'judge-user-2' : j.id === 'judge-3' ? 'judge-user-3' : j.id))
		.filter(Boolean);
	if (judgeUserIds.length === 0) {
		judgeUserIds.push('judge-user-1', 'judge-user-2', 'judge-user-3');
	}

	const judgeVotes = [];  // 用于大屏显示评委投给谁了
	for (let i = 0; i < judgeUserIds.length; i++) {
		const jid = judgeUserIds[i];
		if (sess.judgesVoted.has(jid)) continue;
		sess.judgesVoted.add(jid);
		const j = judgeList[i] || {};
		const votes = Math.max(0, parseInt(j.votes, 10) || JUDGE_VOTES_DEFAULT);
		const side = Math.random() < 0.5 ? 'left' : 'right';
		if (side === 'left') {
			addVotesState(streamId, votes, 0);
			addLiveSessionVotes(streamId, votes, 0);
		} else {
			addVotesState(streamId, 0, votes);
			addLiveSessionVotes(streamId, 0, votes);
		}
		judgeVotes.push({ judgeId: j.id || `judge-${i + 1}`, votedSide: side, votes });
		try {
			db.users.appendVoteRecord(jid, { streamId, liveId, side, votes, at: new Date().toISOString() });
			db.statistics.incrementVotes(votes);
		} catch (e) { /* ignore */ }
	}

	// 2. 普通用户投票：1 次投票行为 = 2 票（全投一方），历史投票次数 +1
	const allUsers = db.users.getAll ? db.users.getAll() : [];
	const eligible = allUsers.filter(u => u.status !== 'banned' && !sess.votedUsers.has(u.id) && !sess.judgesVoted.has(u.id));
	const count = Math.min(eligible.length, Math.max(15, Math.floor(eligible.length * 0.5)));
	const shuffled = eligible.slice().sort(() => Math.random() - 0.5);
	const toVote = shuffled.slice(0, count);

	for (const u of toVote) {
		if (sess.votedUsers.has(u.id)) continue;
		sess.votedUsers.add(u.id);
		const side = Math.random() < 0.5 ? 'left' : 'right';
		if (side === 'left') {
			addVotesState(streamId, USER_VOTES_PER_ACTION, 0);
			addLiveSessionVotes(streamId, USER_VOTES_PER_ACTION, 0);
		} else {
			addVotesState(streamId, 0, USER_VOTES_PER_ACTION);
			addLiveSessionVotes(streamId, 0, USER_VOTES_PER_ACTION);
		}
		try {
			db.users.appendVoteRecord(u.id, { streamId, liveId, side, votes: USER_VOTES_PER_ACTION, at: new Date().toISOString() });
			db.statistics.incrementVotes(USER_VOTES_PER_ACTION);
		} catch (e) { /* ignore */ }
	}

	streamJudgeVotes[streamId] = judgeVotes;
	const v = getVotesState(streamId);
	const total = (v.leftVotes || 0) + (v.rightVotes || 0);
	const mockPayload = {
		streamId,
		leftVotes: v.leftVotes,
		rightVotes: v.rightVotes,
		totalVotes: total,
		allTotalVotes: getAllVotesTotal(),
		source: 'mock',
		judgeVotes,
		timestamp: new Date().toISOString()
	};
	if (st && st.isLive) {
		const sessionV = getLiveSessionVotes(streamId);
		mockPayload.liveSessionLeft = sessionV.leftVotes;
		mockPayload.liveSessionRight = sessionV.rightVotes;
	}
	broadcast('votes-updated', mockPayload);
	console.log(`📊 模拟投票完成: 流 ${streamId}, 评委 ${judgeUserIds.length} 人, 用户 ${toVote.length} 人, 总票 ${total}`);
}

// ==================== 后台管理系统控制接口 ====================

// 一、直播控制接口

// 1.1 开始直播（始终注册，与 PRIORITIZE_BACKEND_SERVER 无关）
app.post('/api/admin/live/start', handleStartLive);
app.post('/api/v1/admin/live/start', handleStartLive);

function handleStartLive(req, res) {
	try {
		const { streamId, autoStartAI = false, notifyUsers = true } = req.body;
		
		// 获取直播流
		const db = require(ADMIN_DB_PATH);
		let stream = null;
		
		if (streamId) {
			stream = db.streams.getById(streamId);
			if (!stream) {
				return res.status(404).json({
					success: false,
					message: '指定的直播流不存在'
				});
			}
		} else {
			stream = db.streams.getActive();
			if (!stream) {
				return res.status(400).json({
					success: false,
					message: '没有可用的直播流，请先配置直播流'
				});
			}
		}
		
		// 禁用的直播流不能开播
		if (stream.enabled === false) {
			return res.status(403).json({
				success: false,
				message: '该直播流已禁用，无法开始直播'
			});
		}
		
		// 检查该流是否已经在直播
		if (streamLiveStatuses[stream.id] && streamLiveStatuses[stream.id].isLive) {
			return res.status(409).json({
				success: false,
				message: '该直播流已经在进行中'
			});
		}
		// ✅ 支持多直播流同时开播：不再自动停止其他流
		
		// 生成直播ID
		const liveId = uuidv4();
		const startTime = new Date().toISOString();
		
		// 更新该流的直播状态
		streamLiveStatuses[stream.id] = {
			isLive: true,
			liveId: liveId,
			startTime: startTime,
			streamUrl: stream.url,
			streamName: stream.name
		};
		
		// 单流在线从 0 开始，由定时波动（每 8-12s ±1-2）自然增长，单流上限 PER_STREAM_ONLINE_CAP
		streamOnlineCounts[stream.id] = 0;
		// 观看人数：重新开播就重新计算，归零；开播后仅随在线人数增加而增加（doOnlineCountFluctuation 中 next>cur 时累加）
		const dbLocal = require(ADMIN_DB_PATH);
		streamViewers[stream.id] = 0;
		try { dbLocal.streamViewersDb.set(stream.id, 0); } catch (e) { /* ignore */ }
		refreshStreamOnlineUserIds(stream.id);
		
		// 确保该流有票数容器，并重置为 0（每次开播重新计票，与观看人数一致）
		setVotesState(stream.id, 0, 0);
		try {
			dbLocal.votes.set(stream.id, 0, 0);
		} catch (e) { /* ignore */ }
		// 本场票数：仅本场真实投票累加，大屏展示用，不受票数管理手动改票影响
		initLiveSessionVotesForStream(stream.id);
		// 新场次：清空该流 mock 投票会话，本场直播内每人可再投一次（每场一次机会，非每流永久一次）
		mockVoteSessions.delete(stream.id);
		const statsNow = dbLocal.statistics.get();
		const startPayload = {
			streamId: stream.id,
			leftVotes: 0,
			rightVotes: 0,
			totalVotes: 0,
			allTotalVotes: getAllVotesTotal(),
			globalTotalVotes: (statsNow && statsNow.totalVotes != null) ? statsNow.totalVotes : getAllVotesTotal(),
			source: 'live-start',
			timestamp: new Date().toISOString()
		};
		startPayload.liveSessionLeft = 0;
		startPayload.liveSessionRight = 0;
		broadcast('votes-updated', startPayload);
		
		// 创建投票会话（本场直播每人只有一次投票机会）
		const sessionKey = `${stream.id}:${liveId}`;
		voteSessions.set(sessionKey, { votedUsers: new Set(), judgesVoted: new Set() });
		
		// 清理旧定时器
		const oldTimers = streamTimers.get(stream.id);
		if (oldTimers) {
			if (oldTimers.judgeTimer) clearTimeout(oldTimers.judgeTimer);
			if (oldTimers.autoStopTimer) clearTimeout(oldTimers.autoStopTimer);
		}
		
		// 开播 15 秒就不进人，开始投票；10 秒内须投完，30 秒自动关播
		const judgeTimer = setTimeout(() => {
			try {
				simulateMockVotes(stream.id, liveId, sessionKey);
			} catch (e) {
				console.error('模拟投票失败:', e);
			}
		}, 15000);
		
		// 1 分钟后自动关播（直播一分钟自动关闭）
		const autoStopTimer = setTimeout(() => {
			try {
				stopStreamLiveInternal(stream.id, 'auto-timeout');
			} catch (e) {
				console.error('自动关播失败:', e);
			}
		}, 60000);
		
		streamTimers.set(stream.id, { judgeTimer, autoStopTimer });
		
		// 更新全局直播状态（任一流直播中）
		globalLiveStatus.isLive = true;
		globalLiveStatus.streamUrl = stream.url;
		globalLiveStatus.streamId = stream.id;
		globalLiveStatus.liveId = liveId;
		globalLiveStatus.startTime = startTime;
		
		// 如果需要自动启动AI（按流启动）
		if (autoStartAI) {
			const aiSessionId = uuidv4();
			streamAIStatuses[stream.id] = {
				status: 'running',
				aiSessionId,
				startTime
			};
			broadcast('aiStatus', {
				status: 'running',
				aiSessionId,
				streamId: stream.id
			});
		}
		
		// 推送直播开始消息到小程序
		if (notifyUsers) {
			broadcast('liveStatus', {
				streamId: stream.id,
				isLive: true,
				status: 'started', // 添加 status 字段
				liveId: liveId,
				streamUrl: stream.url,
				startTime: startTime
			});
			// 同时广播 live-status-changed 消息（兼容旧版前端）
			broadcast('live-status-changed', {
				status: 'started',
				streamUrl: stream.url,
				timestamp: Date.now()
			});
		}
		
		console.log(`✅ 直播已开始: ${liveId}, 流地址: ${stream.url}`);
		
		res.json({
			success: true,
			data: {
				liveId: liveId,
				streamUrl: stream.url,
				status: 'started',
				startTime: startTime,
				notifiedUsers: wsClients.size
			},
			message: '直播已开始',
			timestamp: Date.now()
		});
		
	} catch (error) {
		console.error('开始直播失败:', error);
		res.status(500).json({
			success: false,
			message: '开始直播失败: ' + error.message
		});
	}
}

// 1.2 停止直播（始终注册）
app.post('/api/admin/live/stop', handleStopLive);
app.post('/api/v1/admin/live/stop', handleStopLive);

// 内部停止指定直播流（用于 60s 自动关播等场景）
function stopStreamLiveInternal(streamId, reason = 'manual') {
	if (!streamId) return;
	const st = streamLiveStatuses[streamId];
	if (!st || !st.isLive) return;
	const stopTime = new Date().toISOString();
	st.isLive = false;
	st.stopTime = stopTime;

	// 默认与直播一起停止：停止该流的AI
	if (streamAIStatuses[streamId] && streamAIStatuses[streamId].status === 'running') {
		streamAIStatuses[streamId] = { status: 'stopped', aiSessionId: null, startTime: null };
		broadcast('aiStatus', { status: 'stopped', streamId });
		console.log(`⏹️ 流 ${streamId} 直播已停止，AI已同步停止`);
	}

	// 清除该流在线人数、在线用户集合与观看人数（关播后归零，新开播从 0 开始；在线 +N 则观看 +N）
	streamOnlineCounts[streamId] = 0;
	streamOnlineUserIds[streamId] = new Set();
	try {
		const dbLocal = require(ADMIN_DB_PATH);
		streamViewers[streamId] = 0;
		dbLocal.streamViewersDb.set(streamId, 0);
	} catch (e) { /* ignore */ }

	// 清理定时器
	const timers = streamTimers.get(streamId);
	if (timers) {
		if (timers.judgeTimer) clearTimeout(timers.judgeTimer);
		if (timers.autoStopTimer) clearTimeout(timers.autoStopTimer);
		streamTimers.delete(streamId);
	}

	// 若该流是全局指向的流，且没有其他流直播，则全局置为 false
	const anyLive = Object.values(streamLiveStatuses).some(s => s && s.isLive);
	if (!anyLive) {
		globalLiveStatus.isLive = false;
		globalLiveStatus.streamUrl = null;
		globalLiveStatus.streamId = null;
		globalLiveStatus.liveId = null;
		globalLiveStatus.startTime = null;
	}

	// 广播停止
	broadcast('liveStatus', {
		streamId,
		isLive: false,
		status: 'stopped',
		liveId: st.liveId,
		stopTime,
		reason
	});
	broadcast('live-status-changed', { status: 'stopped', streamId, timestamp: Date.now(), reason });
	try {
		const dbLocal = require(ADMIN_DB_PATH);
		const statsNow = dbLocal.statistics.get();
		let sessionV = getLiveSessionVotes(streamId);
		let sessionLeft = sessionV.leftVotes || 0;
		let sessionRight = sessionV.rightVotes || 0;
		if (sessionLeft === 0 && sessionRight === 0) {
			const cur = getVotesState(streamId);
			sessionLeft = cur.leftVotes || 0;
			sessionRight = cur.rightVotes || 0;
		}
		// 先写回数据统计的投票分析，再初始化票数（结束直播后卡片显示 0）
		accumulateStreamVotesIntoDaily(streamId, sessionLeft, sessionRight);
		initLiveSessionVotesForStream(streamId);
		setVotesState(streamId, 0, 0);
		dbLocal.votes.set(streamId, 0, 0);
		const sessionTotal = sessionLeft + sessionRight;
		broadcast('votes-updated', {
			streamId,
			leftVotes: 0,
			rightVotes: 0,
			totalVotes: 0,
			allTotalVotes: getAllVotesTotal(),
			globalTotalVotes: (statsNow && statsNow.totalVotes != null) ? statsNow.totalVotes : getAllVotesTotal(),
			source: 'live-end-reset',
			timestamp: new Date().toISOString()
		});
	} catch (e) { /* ignore */ }
}

function handleStopLive(req, res) {
	try {
		console.log('📥 [停止直播] 收到请求:', {
			streamId: req.body.streamId,
			saveStatistics: req.body.saveStatistics,
			notifyUsers: req.body.notifyUsers,
			body: req.body
		});
		
		const { streamId, saveStatistics = true, notifyUsers = true } = req.body;
		
		// 确定要停止的流ID
		const targetStreamId = streamId || globalLiveStatus.streamId;
		console.log('📥 [停止直播] 目标流ID:', targetStreamId);
		
		// 如果指定了streamId，检查该流是否在直播
		if (targetStreamId && streamLiveStatuses[targetStreamId] && !streamLiveStatuses[targetStreamId].isLive) {
			return res.json({
				success: true,
				data: {
					status: 'stopped',
					message: '该直播流未在直播，无需停止'
				},
				message: '该直播流未在直播，无需停止',
				timestamp: Date.now()
			});
		}
		
		// 如果没有指定streamId且全局直播未开始，直接返回成功
		if (!targetStreamId && !globalLiveStatus.isLive) {
			return res.json({
				success: true,
				data: {
					status: 'stopped',
					message: '直播未开始，无需停止'
				},
				message: '直播未开始，无需停止',
				timestamp: Date.now()
			});
		}
		
		const stopTime = new Date().toISOString();
		let startTime = null;
		let duration = 0;
		let liveId = null;
		
		// 如果指定了streamId，停止该流
		if (targetStreamId && streamLiveStatuses[targetStreamId]) {
			const streamStatus = streamLiveStatuses[targetStreamId];
			if (streamStatus.isLive) {
				startTime = new Date(streamStatus.startTime);
				duration = Math.floor((Date.now() - startTime.getTime()) / 1000);
				liveId = streamStatus.liveId;
				
				// 更新该流的状态
				streamLiveStatuses[targetStreamId].isLive = false;
				streamLiveStatuses[targetStreamId].stopTime = stopTime;
				
				// 清除该流在线人数、在线用户集合与观看人数（关播后归零，新开播从 0 开始）
				streamOnlineCounts[targetStreamId] = 0;
				streamOnlineUserIds[targetStreamId] = new Set();
				try {
					const dbViewers = require(ADMIN_DB_PATH);
					streamViewers[targetStreamId] = 0;
					dbViewers.streamViewersDb.set(targetStreamId, 0);
				} catch (e) { /* ignore */ }
				
				// 清理该流的定时器（45s评委投票、60s自动关播）
				const timers = streamTimers.get(targetStreamId);
				if (timers) {
					if (timers.judgeTimer) clearTimeout(timers.judgeTimer);
					if (timers.autoStopTimer) clearTimeout(timers.autoStopTimer);
					streamTimers.delete(targetStreamId);
				}
			}
		} else if (globalLiveStatus.isLive) {
			// 停止全局直播状态
			startTime = new Date(globalLiveStatus.startTime);
			duration = Math.floor((Date.now() - startTime.getTime()) / 1000);
			liveId = globalLiveStatus.liveId;
		}
		
		// 如果停止的是当前活跃的流，重置全局状态
		// 修复：只要停止了任何流，都应该检查并更新全局状态
		if (targetStreamId === globalLiveStatus.streamId || !targetStreamId) {
			console.log('🔄 [停止直播] 重置全局状态（流ID匹配）');
			globalLiveStatus.isLive = false;
			globalLiveStatus.streamUrl = null;
			globalLiveStatus.streamId = null;
			globalLiveStatus.liveId = null;
			globalLiveStatus.startTime = null;
			
			// 🔧 修复：清除直播计划，防止自动重启
			try {
				const db = require(ADMIN_DB_PATH);
				db.liveSchedule.clear();
				globalLiveStatus.isScheduled = false;
				globalLiveStatus.scheduledStartTime = null;
				globalLiveStatus.scheduledEndTime = null;
				lastStopTime = Date.now(); // 记录停止时间，防止定时检查器误触发
				console.log('🔄 [停止直播] 已清除直播计划');
			} catch (error) {
				console.error('❌ [停止直播] 清除直播计划失败:', error);
			}
		} else if (targetStreamId && streamLiveStatuses[targetStreamId]) {
			// 如果停止的流不是全局活跃流，但该流确实在直播，也需要检查是否需要更新全局状态
			console.log('🔄 [停止直播] 停止的流与全局流不匹配，但该流在直播，也重置全局状态');
			// 检查是否有其他流在直播
			const otherLiveStream = Object.entries(streamLiveStatuses).find(
				([id, status]) => id !== targetStreamId && status.isLive
			);
			if (!otherLiveStream) {
				// 没有其他流在直播，重置全局状态
				globalLiveStatus.isLive = false;
				globalLiveStatus.streamUrl = null;
				globalLiveStatus.streamId = null;
				globalLiveStatus.liveId = null;
				globalLiveStatus.startTime = null;
				
				// 🔧 修复：清除直播计划，防止自动重启
				try {
					const db = require(ADMIN_DB_PATH);
					db.liveSchedule.clear();
					globalLiveStatus.isScheduled = false;
					globalLiveStatus.scheduledStartTime = null;
					globalLiveStatus.scheduledEndTime = null;
					lastStopTime = Date.now(); // 记录停止时间，防止定时检查器误触发
					console.log('🔄 [停止直播] 已清除直播计划');
				} catch (error) {
					console.error('❌ [停止直播] 清除直播计划失败:', error);
				}
			}
		}
		
		// 统计数据
		const summary = {
			totalViewers: wsClients.size,
			peakViewers: wsClients.size,
			totalVotes: getAllVotesTotal(),
			totalComments: 0,
			totalLikes: 0
		};
		
		// 保存统计数据到数据库
		if (saveStatistics && duration > 0) {
			try {
				console.log('💾 [停止直播] 保存统计数据...');
				const db = require(ADMIN_DB_PATH);
				db.statistics.updateDashboard({
					totalVotes: summary.totalVotes,
					lastLiveTime: stopTime,
					liveDuration: duration
				});
				console.log('✅ [停止直播] 统计数据已保存');
			} catch (dbError) {
				console.error('❌ [停止直播] 保存统计数据失败:', dbError);
				// 不阻塞响应，继续执行
			}
		}
		
		// 推送直播停止消息
		if (notifyUsers) {
			try {
				console.log('📢 [停止直播] 推送停止消息...');
				// 修复：添加 status 字段，确保前端能正确处理
				broadcast('liveStatus', {
					streamId: targetStreamId,
					isLive: false,
					status: 'stopped', // 添加 status 字段
					liveId: liveId,
					stopTime: stopTime
				});
				// 同时广播 live-status-changed 消息（兼容旧版前端）
				broadcast('live-status-changed', {
					status: 'stopped',
					streamId: targetStreamId,
					timestamp: Date.now()
				});
				console.log('✅ [停止直播] 消息已推送');
			} catch (broadcastError) {
				console.error('❌ [停止直播] 推送消息失败:', broadcastError);
				// 不阻塞响应，继续执行
			}
		}
		
		if (targetStreamId) {
			try {
				let sessionV = getLiveSessionVotes(targetStreamId);
				let sessionLeft = sessionV.leftVotes || 0;
				let sessionRight = sessionV.rightVotes || 0;
				if (sessionLeft === 0 && sessionRight === 0) {
					const cur = getVotesState(targetStreamId);
					sessionLeft = cur.leftVotes || 0;
					sessionRight = cur.rightVotes || 0;
				}
				// 先写回本场票比到数据统计的投票分析，再初始化票数为 0
				accumulateStreamVotesIntoDaily(targetStreamId, sessionLeft, sessionRight);
				initLiveSessionVotesForStream(targetStreamId);
				setVotesState(targetStreamId, 0, 0);
				const db = require(ADMIN_DB_PATH);
				db.votes.set(targetStreamId, 0, 0);
				const statsNow = db.statistics.get();
				broadcast('votes-updated', {
					streamId: targetStreamId,
					leftVotes: 0,
					rightVotes: 0,
					totalVotes: 0,
					allTotalVotes: getAllVotesTotal(),
					globalTotalVotes: (statsNow && statsNow.totalVotes != null) ? statsNow.totalVotes : getAllVotesTotal(),
					source: 'live-end-reset',
					timestamp: new Date().toISOString()
				});
			} catch (e) { /* ignore */ }
		}
		
		console.log(`⏹️  [停止直播] 直播已停止: ${liveId}, duration: ${duration}秒`);
		
		const responseData = {
			success: true,
			data: {
				liveId: liveId,
				status: 'stopped',
				stopTime: stopTime,
				duration: duration,
				summary: summary,
				notifiedUsers: wsClients.size
			},
			message: '直播已停止',
			timestamp: Date.now()
		};
		
		console.log('📤 [停止直播] 发送响应:', responseData);
		res.json(responseData);
		console.log('✅ [停止直播] 响应已发送');
		
	} catch (error) {
		console.error('停止直播失败:', error);
		res.status(500).json({
			success: false,
			message: '停止直播失败: ' + error.message
		});
	}
}

// 1.3 更新投票数据（支持按流）
function handleAdminUpdateVotes(req, res) {
	try {
		const { action, leftVotes, rightVotes, reason, notifyUsers = true, streamId } = req.body;
		if (!streamId) {
			return res.status(400).json({ success: false, message: 'streamId 必填' });
		}
		
		if (!action || !['set', 'add', 'reset'].includes(action)) {
			return res.status(400).json({
				success: false,
				message: 'action参数必须是: set / add / reset'
			});
		}
		
		const before = getVotesState(streamId);
		const beforeUpdate = { leftVotes: before.leftVotes, rightVotes: before.rightVotes };
		
		// 执行操作
		switch (action) {
			case 'set':
				setVotesState(streamId, leftVotes, rightVotes);
				break;
			case 'add':
				addVotesState(streamId, leftVotes, rightVotes);
				break;
			case 'reset':
				setVotesState(streamId, 0, 0);
				break;
		}
		
		const cur = getVotesState(streamId);
		// 直播中（含 Mock）时，本场票数同步为当前票数，便于 Mock 模拟/详情弹窗拿到一致的正反方票数
		const stSync = streamLiveStatuses[streamId];
		const isMockLiveSync = mockLiveStreamIds && mockLiveStreamIds.has(streamId);
		if ((stSync && stSync.isLive) || isMockLiveSync) {
			if (action === 'reset') {
				initLiveSessionVotesForStream(streamId);
			} else {
				if (!liveSessionVotesByStream[streamId]) liveSessionVotesByStream[streamId] = { leftVotes: 0, rightVotes: 0 };
				liveSessionVotesByStream[streamId].leftVotes = cur.leftVotes || 0;
				liveSessionVotesByStream[streamId].rightVotes = cur.rightVotes || 0;
			}
		}
		const total = (cur.leftVotes || 0) + (cur.rightVotes || 0);
		const afterUpdate = {
			streamId,
			leftVotes: cur.leftVotes,
			rightVotes: cur.rightVotes,
			totalVotes: total,
			allTotalVotes: getAllVotesTotal(),
			leftPercentage: total > 0 ? Math.round((cur.leftVotes / total) * 100) : 50,
			rightPercentage: total > 0 ? Math.round((cur.rightVotes / total) * 100) : 50
		};
		const stUpd = streamLiveStatuses[streamId];
		if (stUpd && stUpd.isLive) {
			const sessionV = getLiveSessionVotes(streamId);
			afterUpdate.liveSessionLeft = sessionV.leftVotes;
			afterUpdate.liveSessionRight = sessionV.rightVotes;
		}
		
		// 推送更新
		if (notifyUsers) {
			broadcast('votes-updated', afterUpdate);
		}
		
		console.log(`📊 投票数据已更新 (${action}) [${streamId}] reason=${reason || ''}:`, afterUpdate);
		
		res.json({
			success: true,
			data: {
				beforeUpdate,
				afterUpdate,
				updateTime: new Date().toISOString()
			},
			message: '投票数据已更新',
			timestamp: Date.now()
		});
		
	} catch (error) {
		console.error('更新投票数据失败:', error);
		res.status(500).json({
			success: false,
			message: '更新投票数据失败: ' + error.message
		});
	}
}

app.post('/api/admin/live/update-votes', handleAdminUpdateVotes);
app.post('/api/v1/admin/live/update-votes', handleAdminUpdateVotes);

// 1.4 重置投票数据（支持按流）
function handleAdminResetVotes(req, res) {
	try {
		const { resetTo, saveBackup = true, notifyUsers = true, streamId } = req.body;
		if (!streamId) {
			return res.status(400).json({ success: false, message: 'streamId 必填' });
		}
		
		// 备份当前数据
		const backup = saveBackup ? {
			backupId: uuidv4(),
			leftVotes: getVotesState(streamId).leftVotes,
			rightVotes: getVotesState(streamId).rightVotes,
			timestamp: new Date().toISOString()
		} : null;
		
		// 重置票数
		if (resetTo) {
			setVotesState(streamId, resetTo.leftVotes, resetTo.rightVotes);
		} else {
			setVotesState(streamId, 0, 0);
		}
		
		const cur = getVotesState(streamId);
		const total = (cur.leftVotes || 0) + (cur.rightVotes || 0);
		const currentVotesData = {
			streamId,
			leftVotes: cur.leftVotes,
			rightVotes: cur.rightVotes,
			totalVotes: total,
			allTotalVotes: getAllVotesTotal(),
			leftPercentage: total > 0 ? Math.round((cur.leftVotes / total) * 100) : 50,
			rightPercentage: total > 0 ? Math.round((cur.rightVotes / total) * 100) : 50
		};
		const stReset = streamLiveStatuses[streamId];
		if (stReset && stReset.isLive) {
			const sessionV = getLiveSessionVotes(streamId);
			currentVotesData.liveSessionLeft = sessionV.leftVotes;
			currentVotesData.liveSessionRight = sessionV.rightVotes;
		}
		
		// 推送更新
		if (notifyUsers) {
			broadcast('votes-updated', currentVotesData);
		}
		
		console.log('🔄 投票数据已重置');
		
		res.json({
			success: true,
			data: {
				backup,
				currentVotes: currentVotesData
			},
			message: '投票数据已重置',
			timestamp: Date.now()
		});
		
	} catch (error) {
		console.error('重置投票数据失败:', error);
		res.status(500).json({
			success: false,
			message: '重置投票数据失败: ' + error.message
		});
	}
}

app.post('/api/admin/live/reset-votes', handleAdminResetVotes);
app.post('/api/v1/admin/live/reset-votes', handleAdminResetVotes);

// 二、AI控制接口

// 2.1 启动AI识别
// 注意：如果 PRIORITIZE_BACKEND_SERVER = true，这些路由会被代理替代，不会执行
if (!PRIORITIZE_BACKEND_SERVER) {
	const handleAIStart = (req, res) => {
	try {
		const { settings, notifyUsers = true, streamId } = req.body;
		
		// 支持按流启动AI（streamId 指定时只启动该流的AI）
		const targetStreamId = streamId || null;
		if (targetStreamId && streamAIStatuses[targetStreamId] && streamAIStatuses[targetStreamId].status === 'running') {
			return res.status(409).json({
				success: false,
				message: '该流的AI识别已在运行中'
			});
		}
		if (!targetStreamId && globalAIStatus.status === 'running') {
			return res.status(409).json({
				success: false,
				message: 'AI识别已在运行中'
			});
		}
		
		// 更新设置
		if (settings) {
			globalAIStatus.settings = {
				...globalAIStatus.settings,
				...settings
			};
		}
		
		const aiSessionId = uuidv4();
		const startTime = new Date().toISOString();
		
		if (targetStreamId) {
			streamAIStatuses[targetStreamId] = {
				status: 'running',
				aiSessionId,
				startTime
			};
		} else {
			globalAIStatus.status = 'running';
			globalAIStatus.aiSessionId = aiSessionId;
			globalAIStatus.startTime = startTime;
			globalAIStatus.statistics = {
				totalContents: 0,
				totalWords: 0,
				averageConfidence: 0
			};
		}
		
		// 推送AI启动消息（带 streamId 供前端区分）
		if (notifyUsers) {
			broadcast('aiStatus', {
				status: 'running',
				aiSessionId,
				streamId: targetStreamId
			});
		}
		
		// AI启动时自动生成提前准备好的文案，保存到 AI 内容管理模块
		const preparedTexts = [
			{ text: "正方补充：痛苦让我们珍惜快乐，没有对比就没有真正的幸福。", side: "left" },
			{ text: "反方补充：现代医学已经在消除很多痛苦，这个按钮只是技术的延伸。", side: "right" },
			{ text: "正方质疑：如果所有人都按这个按钮，社会会变成什么样？", side: "left" },
			{ text: "反方回应：每个人都有自己的选择权，不应该强迫别人承受痛苦。", side: "right" }
		];
		for (let i = 0; i < 3; i++) {
			const p = preparedTexts[i % preparedTexts.length];
			const newContent = {
				id: uuidv4(),
				debate_id: debateTopic.id,
				text: p.text,
				side: p.side,
				timestamp: new Date().getTime(),
				comments: [],
				likes: Math.floor(Math.random() * 20) + 10,
				streamId: targetStreamId || globalLiveStatus.streamId || null
			};
			aiDebateContent.unshift(newContent);
		}
		broadcast('newAIContent', { streamId: targetStreamId });
		
		console.log(`🤖 AI识别已启动: ${aiSessionId}${targetStreamId ? ' (流: ' + targetStreamId + ')' : ''}`);
		
		res.json({
			success: true,
			data: {
				aiSessionId,
				status: 'running',
				startTime,
				streamId: targetStreamId,
				settings: globalAIStatus.settings
			},
			message: 'AI识别已启动',
			timestamp: Date.now()
		});
		
	} catch (error) {
		console.error('启动AI识别失败:', error);
		res.status(500).json({
			success: false,
			message: '启动AI识别失败: ' + error.message
		});
	}
	};
	app.post('/api/admin/ai/start', handleAIStart);
	app.post('/api/v1/admin/ai/start', handleAIStart);
}

// 2.2 停止AI识别
// 注意：如果 PRIORITIZE_BACKEND_SERVER = true，这些路由会被代理替代，不会执行
if (!PRIORITIZE_BACKEND_SERVER) {
	const handleAIStop = (req, res) => {
	try {
		const { saveHistory = true, notifyUsers = true, streamId } = req.body;
		const targetStreamId = streamId || null;
		
		if (targetStreamId) {
			// 按流停止AI
			const st = streamAIStatuses[targetStreamId];
			if (!st || st.status !== 'running') {
				return res.status(400).json({
					success: false,
					message: '该流的AI识别未运行'
				});
			}
			const aiSessionId = st.aiSessionId;
			streamAIStatuses[targetStreamId] = { status: 'stopped', aiSessionId: null, startTime: null };
			if (notifyUsers) {
				broadcast('aiStatus', { status: 'stopped', aiSessionId, streamId: targetStreamId });
			}
			console.log(`⏹️  流 ${targetStreamId} AI识别已停止`);
			return res.json({
				success: true,
				data: { aiSessionId, status: 'stopped', streamId: targetStreamId },
				message: 'AI识别已停止',
				timestamp: Date.now()
			});
		}
		
		if (globalAIStatus.status === 'stopped') {
			return res.status(400).json({
				success: false,
				message: 'AI识别未运行'
			});
		}
		
		const stopTime = new Date().toISOString();
		const startTime = new Date(globalAIStatus.startTime);
		const duration = Math.floor((Date.now() - startTime.getTime()) / 1000);
		
		const aiSessionId = globalAIStatus.aiSessionId;
		const summary = { ...globalAIStatus.statistics };
		
		// 重置状态
		globalAIStatus.status = 'stopped';
		globalAIStatus.aiSessionId = null;
		globalAIStatus.startTime = null;
		
		// 推送AI停止消息
		if (notifyUsers) {
			broadcast('aiStatus', {
				status: 'stopped',
				aiSessionId: aiSessionId
			});
		}
		
		console.log(`⏹️  AI识别已停止: ${aiSessionId}`);
		
		res.json({
			success: true,
			data: {
				aiSessionId: aiSessionId,
				status: 'stopped',
				stopTime: stopTime,
				duration: duration,
				summary: summary
			},
			message: 'AI识别已停止',
			timestamp: Date.now()
		});
		
	} catch (error) {
		console.error('停止AI识别失败:', error);
		res.status(500).json({
			success: false,
			message: '停止AI识别失败: ' + error.message
		});
	}
	};
	app.post('/api/admin/ai/stop', handleAIStop);
	app.post('/api/v1/admin/ai/stop', handleAIStop);
}

// 2.3 暂停/恢复AI识别
// 注意：如果 PRIORITIZE_BACKEND_SERVER = true，这些路由会被代理替代，不会执行
if (!PRIORITIZE_BACKEND_SERVER) {
	app.post('/api/admin/ai/toggle', (req, res) => {
	try {
		const { action, notifyUsers = true } = req.body;
		
		if (!action || !['pause', 'resume'].includes(action)) {
			return res.status(400).json({
				success: false,
				message: 'action参数必须是: pause / resume'
			});
		}
		
		if (action === 'pause') {
			if (globalAIStatus.status !== 'running') {
				return res.status(400).json({
					success: false,
					message: 'AI识别未运行，无法暂停'
				});
			}
			globalAIStatus.status = 'paused';
		} else if (action === 'resume') {
			if (globalAIStatus.status !== 'paused') {
				return res.status(400).json({
					success: false,
					message: 'AI识别未暂停，无法恢复'
				});
			}
			globalAIStatus.status = 'running';
		}
		
		// 推送状态变更
		if (notifyUsers) {
			broadcast('aiStatus', {
				status: globalAIStatus.status
			});
		}
		
		console.log(`🤖 AI识别状态已变更: ${globalAIStatus.status}`);
		
		res.json({
			success: true,
			data: {
				aiSessionId: globalAIStatus.aiSessionId,
				status: globalAIStatus.status,
				actionTime: new Date().toISOString()
			},
			message: globalAIStatus.status === 'paused' ? 'AI识别已暂停' : 'AI识别已恢复',
			timestamp: Date.now()
		});
		
	} catch (error) {
		console.error('切换AI状态失败:', error);
		res.status(500).json({
			success: false,
			message: '切换AI状态失败: ' + error.message
		});
	}
	});
}

// 2.4 删除AI内容
app.delete('/api/admin/ai/content/:contentId', (req, res) => {
	try {
		const { contentId } = req.params;
		const { reason, notifyUsers = true } = req.body;
		
		if (!contentId) {
			return res.status(400).json({
				success: false,
				message: '缺少内容ID'
			});
		}
		
		// 这里应该从数据库删除AI内容
		// 暂时模拟删除成功
		
		// 推送删除消息
		if (notifyUsers) {
			broadcast('aiContentDeleted', {
				contentId: contentId
			});
		}
		
		console.log(`🗑️  AI内容已删除: ${contentId}`);
		
		res.json({
			success: true,
			data: {
				contentId: contentId,
				deleteTime: new Date().toISOString(),
				reason: reason || '管理员删除'
			},
			message: '内容已删除',
			timestamp: Date.now()
		});
		
	} catch (error) {
		console.error('删除AI内容失败:', error);
		res.status(500).json({
			success: false,
			message: '删除AI内容失败: ' + error.message
		});
	}
});

// 三、数据查询接口

// 3.1 实时数据概览
app.get('/api/admin/dashboard', (req, res) => {
	try {
		const db = require(ADMIN_DB_PATH);
		const users = db.users.getAll();
		const debate = db.debate.get();
		const sid = req.query.stream_id || globalLiveStatus.streamId || null;
		const v = sid ? getVotesState(sid) : { leftVotes: 0, rightVotes: 0 };
		const totalVotes = (v.leftVotes || 0) + (v.rightVotes || 0);
		const leftPercentage = totalVotes > 0 ? Math.round((v.leftVotes / totalVotes) * 100) : 50;
		const rightPercentage = totalVotes > 0 ? Math.round((v.rightVotes / totalVotes) * 100) : 50;
		
		// 计算直播时长
		let liveDuration = 0;
		if (globalLiveStatus.isLive && globalLiveStatus.startTime) {
			const startTime = new Date(globalLiveStatus.startTime);
			liveDuration = Math.floor((Date.now() - startTime.getTime()) / 1000);
		}
		
		// 获取启用的直播流（从数据库查询，即使直播未开始也会返回）
		let activeStream = null;
		try {
			activeStream = db.streams.getActive();
		} catch (error) {
			console.warn('获取启用直播流失败:', error);
		}
		// 总投票数：所有直播每一次投票累计，持久化
		const statsData = db.statistics.get();
		const globalTotalVotesDashboard = (statsData && statsData.totalVotes != null) ? statsData.totalVotes : getAllVotesTotal();
		
		const data = {
			totalUsers: users.length,
			activeUsers: wsClients.size,
			isLive: globalLiveStatus.isLive,
			liveStreamUrl: globalLiveStatus.streamUrl,
			streamId: sid, // 当前查询/直播使用的流ID
			// 添加启用的直播流信息（从数据库查询，方便小程序获取测试流地址）
			activeStreamUrl: activeStream ? activeStream.url : null,
			activeStreamId: activeStream ? activeStream.id : null,
			activeStreamName: activeStream ? activeStream.name : null,
			totalVotes: totalVotes,
			allTotalVotes: getAllVotesTotal(),
			globalTotalVotes: globalTotalVotesDashboard,
			leftVotes: v.leftVotes,
			rightVotes: v.rightVotes,
			leftPercentage: leftPercentage,
			rightPercentage: rightPercentage,
			totalComments: 0,  // 可从数据库获取
			totalLikes: 0,     // 可从数据库获取
			aiStatus: globalAIStatus.status,
			debateTopic: {
				title: debate.title,
				leftSide: debate.leftPosition,
				rightSide: debate.rightPosition,
				description: debate.description
			},
			liveStartTime: globalLiveStatus.startTime,
			liveDuration: liveDuration
		};
		
		res.json({
			success: true,
			data: data,
			timestamp: Date.now()
		});
		
	} catch (error) {
		console.error('获取数据概览失败:', error);
		res.status(500).json({
			success: false,
			message: '获取数据概览失败: ' + error.message
		});
	}
});

// 3.2 用户列表
app.get('/api/admin/miniprogram/users', (req, res) => {
	try {
		const db = require(ADMIN_DB_PATH);
		const users = db.users.getAll();
		
		const page = parseInt(req.query.page) || 1;
		const pageSize = parseInt(req.query.pageSize) || 20;
		const status = req.query.status || 'all';
		const orderBy = req.query.orderBy || 'joinTime';
		
		// 过滤用户
		let filteredUsers = users;
		if (status === 'online') {
			// 简化处理：假设所有WebSocket连接的用户都是在线
			filteredUsers = users.filter(u => wsClients.size > 0);
		}
		
		// 排序
		filteredUsers.sort((a, b) => {
			if (orderBy === 'votes') {
				return ((b.statistics && b.statistics.totalVotes) || 0) - ((a.statistics && a.statistics.totalVotes) || 0);
			}
			return new Date(b.joinTime) - new Date(a.joinTime);
		});
		
		// 分页
		const total = filteredUsers.length;
		const start = (page - 1) * pageSize;
		const end = start + pageSize;
		const paginatedUsers = filteredUsers.slice(start, end);
		
		res.json({
			success: true,
			data: {
				total: total,
				page: page,
				pageSize: pageSize,
				users: paginatedUsers.map(u => ({
					userId: u.id,
					nickname: u.nickname,
					avatar: u.avatar,
					status: 'online',  // 简化处理
					lastActiveTime: new Date().toISOString(),
					statistics: u.statistics || {
						totalVotes: 0,
						totalComments: 0,
						totalLikes: 0,
						currentPosition: 'neutral'
					},
					joinTime: u.createdAt || new Date().toISOString()
				}))
			},
			timestamp: Date.now()
		});
		
	} catch (error) {
		console.error('获取用户列表失败:', error);
		res.status(500).json({
			success: false,
			message: '获取用户列表失败: ' + error.message
		});
	}
});

// 3.3 投票统计
app.get('/api/admin/votes/statistics', (req, res) => {
	try {
		const timeRange = req.query.timeRange || '1h';
		const allTotalVotes = getAllVotesTotal();
		// 为兼容旧接口：默认取全局指向流的票数占比
		const sid = globalLiveStatus.streamId || null;
		const v = sid ? getVotesState(sid) : { leftVotes: 0, rightVotes: 0 };
		const totalVotes = (v.leftVotes || 0) + (v.rightVotes || 0);
		const leftPercentage = totalVotes > 0 ? Math.round((v.leftVotes / totalVotes) * 100) : 50;
		const rightPercentage = totalVotes > 0 ? Math.round((v.rightVotes / totalVotes) * 100) : 50;
		
		// 简化：生成模拟时间轴数据
		const timeline = [];
		const now = new Date();
		for (let i = 0; i < 10; i++) {
			const time = new Date(now.getTime() - i * 60000);  // 每分钟一个点
			timeline.unshift({
				timestamp: time.toISOString(),
				leftVotes: Math.floor((v.leftVotes || 0) * (10 - i) / 10),
				rightVotes: Math.floor((v.rightVotes || 0) * (10 - i) / 10),
				totalVotes: Math.floor((allTotalVotes || 0) * (10 - i) / 10),
				activeUsers: wsClients.size
			});
		}
		
		res.json({
			success: true,
			data: {
				summary: {
					totalVotes: allTotalVotes,
					leftVotes: v.leftVotes,
					rightVotes: v.rightVotes,
					leftPercentage: leftPercentage,
					rightPercentage: rightPercentage,
					growthRate: 5.2
				},
				timeline: timeline,
				topVoters: []  // 可从数据库获取
			},
			timestamp: Date.now()
		});
		
	} catch (error) {
		console.error('获取投票统计失败:', error);
		res.status(500).json({
			success: false,
			message: '获取投票统计失败: ' + error.message
		});
	}
});

// 3.4 AI内容列表（已在上面定义，此处删除重复定义）

// ==================== 直播流管理接口 ====================

// 获取所有直播流列表
/**
 * 生成播放地址（playUrls）
 * 根据流类型自动生成 HLS、FLV、RTMP 播放地址
 */
function generatePlayUrls(stream) {
	const playUrls = {
		hls: null,
		flv: null,
		rtmp: null
	};
	
	try {
		// 获取服务器IP地址（用于生成转换后的播放地址）
		const serverIP = process.env.SERVER_IP || '192.168.43.247';
		const hlsServerPort = process.env.HLS_SERVER_PORT || '8086';
		const rtmpServerPort = process.env.RTMP_SERVER_PORT || '1935';
		
		// 从原URL中提取流名称（用于RTMP转HLS）
		const getStreamName = (url) => {
			try {
				const urlObj = new URL(url);
				const path = urlObj.pathname;
				// 提取路径的最后一部分作为流名称
				// 例如: rtmp://localhost/live/stream1 -> stream1
				const parts = path.split('/').filter(p => p);
				return parts[parts.length - 1] || 'stream';
			} catch (e) {
				// 如果URL解析失败，尝试从字符串中提取
				const match = url.match(/([^\/]+)(?:\.[^\.]+)?$/);
				return match ? match[1] : 'stream';
			}
		};
		
		switch (stream.type) {
			case 'hls':
				// HLS流直接使用原地址
				playUrls.hls = stream.url;
				// 尝试从HLS地址生成FLV地址（如果可能）
				if (stream.url.includes('.m3u8')) {
					playUrls.flv = stream.url.replace('.m3u8', '.flv');
				}
				break;
				
			case 'rtmp':
				// RTMP流需要转换为HLS
				const streamName = getStreamName(stream.url);
				// 生成HLS播放地址（通过流媒体服务器转换）
				playUrls.hls = `http://${serverIP}:${hlsServerPort}/live/${streamName}.m3u8`;
				playUrls.flv = `http://${serverIP}:${hlsServerPort}/live/${streamName}.flv`;
				playUrls.rtmp = stream.url.replace('localhost', serverIP).replace(/^rtmp:\/\//, `rtmp://${serverIP}:${rtmpServerPort}/`);
				break;
				
			case 'flv':
				// FLV流
				playUrls.flv = stream.url;
				// 尝试从FLV地址生成HLS地址
				if (stream.url.includes('.flv')) {
					const streamName = getStreamName(stream.url);
					playUrls.hls = `http://${serverIP}:${hlsServerPort}/live/${streamName}.m3u8`;
				}
				break;
				
			default:
				// 未知类型，尝试使用原地址
				playUrls.hls = stream.url;
				break;
		}
		
		// 确保至少有一个播放地址
		if (!playUrls.hls && stream.url) {
			playUrls.hls = stream.url;
		}
		
	} catch (error) {
		console.error('生成播放地址失败:', error);
		// 如果生成失败，至少使用原URL作为HLS地址
		playUrls.hls = stream.url;
	}
	
	return playUrls;
}

app.get('/api/admin/streams', (req, res) => {
	try {
		const streams = db.streams.getAll();
		
		// 为每个流添加直播状态和播放地址
		const streamsWithStatus = streams.map(stream => {
			const status = streamLiveStatuses[stream.id] || { isLive: false };
			
			// 生成播放地址（playUrls）
			const playUrls = generatePlayUrls(stream);
			
			return {
				...stream,
				// ✅ 新增：播放地址字段
				playUrls: playUrls,
				liveStatus: {
					isLive: status.isLive || false,
					liveId: status.liveId || null,
					startTime: status.startTime || null,
					stopTime: status.stopTime || null,
					streamUrl: status.streamUrl || stream.url
				}
			};
		});
		
		res.json({
			success: true,
			data: {
				streams: streamsWithStatus,
				total: streams.length
			},
			timestamp: Date.now()
		});
		
	} catch (error) {
		console.error('获取直播流列表失败:', error);
		res.status(500).json({
			success: false,
			message: '获取直播流列表失败: ' + error.message
		});
	}
});

// 添加新的直播流
app.post('/api/admin/streams', (req, res) => {
	try {
		const { name, url, type, description, enabled } = req.body;
		
		// 参数验证
		if (!name || !url || !type) {
			return res.status(400).json({
				success: false,
				message: '缺少必要参数: name, url, type 必填'
			});
		}
		
		// 验证URL格式
		try {
			new URL(url);
		} catch (e) {
			return res.status(400).json({
				success: false,
				message: '流地址格式不正确，请输入有效的URL'
			});
		}
		
		// 验证type
		if (!['hls', 'rtmp', 'flv'].includes(type)) {
			return res.status(400).json({
				success: false,
				message: 'type 必须是 hls, rtmp 或 flv'
			});
		}
		
		// 创建新流
		const newStream = {
			id: `stream-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
			name: name.trim(),
			url: url.trim(),
			type,
			description: description ? description.trim() : '',
			enabled: enabled !== false, // 默认启用
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString()
		};
		
		// 保存到数据库
		db.streams.add(newStream);
		
		console.log('✅ 新增直播流:', newStream.name, newStream.url);
		
		res.json({
			success: true,
			data: newStream,
			message: '直播流添加成功',
			timestamp: Date.now()
		});
		
	} catch (error) {
		console.error('添加直播流失败:', error);
		res.status(500).json({
			success: false,
			message: '添加直播流失败: ' + error.message
		});
	}
});

// 更新直播流
app.put('/api/admin/streams/:id', (req, res) => {
	try {
		const streamId = req.params.id; // 统一使用 :id 参数名
		const { name, url, type, description, enabled } = req.body;
		
		// 查找流
		const stream = db.streams.getById(streamId);
		if (!stream) {
			return res.status(404).json({
				success: false,
				message: '直播流不存在'
			});
		}
		
		// 验证URL格式（如果有更新）
		if (url) {
			try {
				new URL(url);
			} catch (e) {
				return res.status(400).json({
					success: false,
					message: '流地址格式不正确，请输入有效的URL'
				});
			}
		}
		
		// 验证type（如果有更新）
		if (type && !['hls', 'rtmp', 'flv'].includes(type)) {
			return res.status(400).json({
				success: false,
				message: 'type 必须是 hls, rtmp 或 flv'
			});
		}
		
		// 更新字段
		const updates = {};
		if (name !== undefined) updates.name = name.trim();
		if (url !== undefined) updates.url = url.trim();
		if (type !== undefined) updates.type = type;
		if (description !== undefined) updates.description = description.trim();
		if (enabled !== undefined) updates.enabled = enabled;
		updates.updatedAt = new Date().toISOString();
		
		// 保存更新
		const updatedStream = db.streams.update(streamId, updates);
		
		console.log('✅ 更新直播流:', streamId, updates);
		
		res.json({
			success: true,
			data: updatedStream,
			message: '直播流更新成功',
			timestamp: Date.now()
		});
		
	} catch (error) {
		console.error('更新直播流失败:', error);
		res.status(500).json({
			success: false,
			message: '更新直播流失败: ' + error.message
		});
	}
});

// 删除直播流
app.delete('/api/admin/streams/:id', (req, res) => {
	try {
		const streamId = req.params.id; // 统一使用 :id 参数名
		
		// 查找流
		const stream = db.streams.getById(streamId);
		if (!stream) {
			return res.status(404).json({
				success: false,
				message: '直播流不存在'
			});
		}
		
		// 检查是否正在使用
		if (globalLiveStatus && globalLiveStatus.streamId === streamId) {
			return res.status(400).json({
				success: false,
				message: '该直播流正在使用中，请先停止直播'
			});
		}
		
		// 删除
		db.streams.delete(streamId);
		
		console.log('✅ 删除直播流:', streamId, stream.name);
		
		res.json({
			success: true,
			data: {
				id: streamId,
				name: stream.name
			},
			message: '直播流删除成功',
			timestamp: Date.now()
		});
		
	} catch (error) {
		console.error('删除直播流失败:', error);
		res.status(500).json({
			success: false,
			message: '删除直播流失败: ' + error.message
		});
	}
});

// 启动服务器（监听 0.0.0.0 便于 Render 等云平台）
server.listen(port, '0.0.0.0', () => {
    const localIP = getLocalIP();
    console.log('');
    printConfig();
    console.log(`辩题: ${debateTopic.title}`);
    console.log(`状态: ✅ 服务器运行中 (端口: ${port}, 来自环境变量 PORT)`);
    console.log(`🌐 本地: http://localhost:${port}`);
    console.log(`🌐 本机(所在地) IP: http://${localIP}:${port}`);
    console.log(`📌 后台管理: http://localhost:${port}/admin`);
    if (wss) {
        console.log(`🌐 WebSocket: ws://localhost:${port}/ws 或 ws://${localIP}:${port}/ws`);
    }
    if (BACKEND_SERVER_URL) {
        console.log(`🔗 /api 代理到后端: ${BACKEND_SERVER_URL}`);
    }
    console.log('═══════════════════════════════════════');
    console.log('');
    
    // 加载持久化的观看人数到内存（累计只增不减，直播停止后保留）
    try {
        const viewersMap = require(ADMIN_DB_PATH).streamViewersDb.getAll();
        Object.keys(viewersMap).forEach(sid => { streamViewers[sid] = viewersMap[sid]; });
    } catch (e) { /* ignore */ }
    
    // 只在模拟模式下启动模拟数据
    if (currentConfig.mode === 'mock') {
        simulateVoteChanges();
        simulateNewAIContent();
        console.log('🤖 模拟数据生成器已启动');
    }
    
    // 启动直播计划检查
    startScheduleCheck();
    console.log('⏰ 直播计划定时检查已启动');
});

// ==================== 代理未匹配的 API 请求到后端服务器 ====================
// 在所有本地路由之后，将未匹配的 API 请求代理到后端服务器
// 注意：如果 PRIORITIZE_BACKEND_SERVER 为 true，这个代理不会执行（因为已经在前面处理了）
// 注意：Express 路由是按顺序匹配的，如果本地路由已经匹配并处理了请求，就不会到达这里
// 所以这个代理只会处理本地路由没有匹配的请求
if (BACKEND_SERVER_URL && !PRIORITIZE_BACKEND_SERVER) {
	console.log(`🔧 配置后端代理: /api/* -> ${BACKEND_SERVER_URL}`);
	// 配置代理中间件
	const proxyOptions = {
		target: BACKEND_SERVER_URL,
		changeOrigin: true, // 修改请求头中的 origin
		pathRewrite: {
			// 保持原始路径不变，直接转发
		},
		onProxyReq: (proxyReq, req, res) => {
			// 在转发请求前可以修改请求头
			console.log(`🔄 [代理] ${req.method} ${req.path} -> ${BACKEND_SERVER_URL}${req.path}`);
		},
		onProxyRes: (proxyRes, req, res) => {
			// 在收到响应后可以修改响应
			console.log(`✅ [代理] ${req.path} <- ${proxyRes.statusCode} ${BACKEND_SERVER_URL}`);
		},
		onError: (err, req, res) => {
			console.error(`❌ [代理错误] ${req.path}:`, err.message);
			// 如果响应还没有发送，返回错误信息
			if (!res.headersSent) {
				res.status(502).json({
					success: false,
					error: 'Bad Gateway',
					message: `无法连接到后端服务器 ${BACKEND_SERVER_URL}`,
					path: req.path,
					details: err.message
				});
			}
		}
	};
	
	// 创建代理中间件
	// 注意：createProxyMiddleware 的第一个参数是配置对象，路径在 app.use 中指定
	const backendProxy = createProxyMiddleware(proxyOptions);
	
	// 在所有本地路由之后，404处理器之前，添加代理中间件
	// 这样，如果本地路由没有匹配，就会尝试代理到后端服务器
	
	// 🔍 调试：添加测试中间件，看看请求是否到达这里
	app.use('/api', (req, res, next) => {
		console.log(`🔍 [调试] API请求到达代理位置: ${req.method} ${req.path}`);
		next(); // 继续到代理中间件
	});
	
	app.use('/api', backendProxy);
	console.log('✅ 后端代理中间件已添加到路由栈');
} else if (!PRIORITIZE_BACKEND_SERVER) {
	console.log('⚠️  后端代理未配置（BACKEND_SERVER_URL 或 PRIORITIZE_BACKEND_SERVER 不满足条件）');
}

// ==================== 其他请求 ====================
// Chrome DevTools 等会请求 /.well-known/...，静默返回 204 避免控制台警告
app.use('/.well-known', (req, res) => {
	res.status(204).end();
});

// ==================== 404处理器（必须在所有路由之后） ====================
// 404处理器（API 路由）
app.use((req, res) => {
	// 如果是 API 请求，返回 JSON 格式错误
	if (req.path.startsWith('/api')) {
		console.log(`⚠️  API路由未找到: ${req.method} ${req.path}`);
		res.status(404).json({
			success: false,
			error: 'Not Found',
			path: req.path,
			message: `API路由 ${req.path} 未定义，且无法连接到后端服务器`
		});
	} else {
		// 其他请求返回 404
		console.log(`⚠️  路由未找到: ${req.method} ${req.url}`);
		res.status(404).json({
			error: 'Not Found',
			path: req.url,
			message: `路由 ${req.url} 未定义`
		});
	}
});

module.exports = app;
