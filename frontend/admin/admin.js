// 后台管理系统主逻辑
// 使用同源：API 和 WebSocket 都走当前页面的域名，由网关代理到后端（localhost:8080 或 192.168.43.247:8080 均可）
const SERVER_CONFIG = {
	LOCAL_URL: 'http://localhost:8080',
	get BASE_URL() {
		if (typeof window !== 'undefined' && window.location && window.location.origin) {
			return window.location.origin;
		}
		return this.LOCAL_URL;
	},
	get WEB_SOCKET_URL() {
		if (typeof window !== 'undefined' && window.location && window.location.origin) {
			return window.location.origin;
		}
		return this.LOCAL_URL;
	}
};

// 将配置挂载到 window 对象，供其他脚本使用
window.SERVER_CONFIG = SERVER_CONFIG;

// API_BASE只保留基础URL，具体路径在各个API函数中定义
const API_BASE = `${SERVER_CONFIG.BASE_URL}/api/admin`;

// 全局状态（如果admin-api.js已经创建了简单的版本，这里会覆盖它）
const globalState = window.globalState || {
	isLive: false,
	liveId: null,
	aiStatus: 'stopped', // stopped / running / paused
	aiSessionId: null,
	currentVotes: {
		leftVotes: 0,
		rightVotes: 0
	}
};

// 扩展globalState对象，添加缺失的属性
globalState.liveId = globalState.liveId || null;
globalState.aiSessionId = globalState.aiSessionId || null;
globalState.currentVotes = globalState.currentVotes || {
	leftVotes: 0,
	rightVotes: 0
};

// 确保window.globalState引用的是这个对象
window.globalState = globalState;

// WebSocket 连接
let ws = null;
let wsReconnectTimer = null;

// 页面导航
document.addEventListener('DOMContentLoaded', async () => {
	initNavigation();

	// 多直播流卡片：仅前端 Mock 控制（与改前一致，不请求 /api/v1/admin/live/start，避免 404）
	document.body.addEventListener('click', function onMockStreamBtnClick(e) {
		const btn = e.target.closest('.mock-stream-btn');
		if (!btn || btn.disabled) return;
		const streamId = btn.getAttribute('data-stream-id');
		if (!streamId) return;
		e.preventDefault();
		e.stopPropagation();
		const isLive = typeof mockIsStreamLive === 'function' && mockIsStreamLive(streamId);
		if (typeof mockControlStreamLive === 'function') mockControlStreamLive(streamId, !isLive);
	});
	
	// 数据概览页：纯前端 Mock 模拟，初始化 Mock 状态
	if (typeof mockInitDashboard === 'function') mockInitDashboard();
	
	// 先尝试加载流列表（用于多直播总览卡片）
	const streamSelect = document.getElementById('stream-select');
	if (streamSelect) {
		try {
			await loadStreamsToSelect();
		} catch (error) {
			console.warn('⚠️ 加载流列表失败，继续加载 Dashboard:', error);
		}
	}
	
	// 加载多直播总览（Mock 模式，仅获取流列表）
	if (typeof renderMultiLiveOverview === 'function') renderMultiLiveOverview();
	
	// 加载 Dashboard（其他页面可能仍需要）
	loadDashboard();
	
	initWebSocket();
	setInterval(updateDashboard, 10000);
	
	window.addEventListener('streams-list-updated', () => {
		if (typeof loadStreamsToSelect === 'function') loadStreamsToSelect();
		if (typeof renderMultiLiveOverview === 'function') renderMultiLiveOverview();
	});
});

// 初始化 WebSocket 连接
function initWebSocket() {
	// 从服务器配置获取WebSocket地址
	try {
		// 使用专门的 WebSocket URL（如果配置了），否则使用 BASE_URL
		const wsBaseUrl = SERVER_CONFIG.WEB_SOCKET_URL || SERVER_CONFIG.BASE_URL;
		
		// 如果 WebSocket URL 为 null 或未配置，禁用 WebSocket
		if (!wsBaseUrl) {
			console.log('ℹ️ WebSocket 已禁用（未配置 WebSocket URL）');
			updateConnectionStatus(false);
			return;
		}
		
		const baseUrl = new URL(wsBaseUrl);
		const protocol = baseUrl.protocol === 'https:' ? 'wss:' : 'ws:';
		const wsUrl = `${protocol}//${baseUrl.host}/ws`;
		
		console.log('🔌 连接WebSocket:', wsUrl);
		
		// 如果已有连接，先关闭
		if (ws && ws.readyState !== WebSocket.CLOSED) {
			try {
				ws.close();
			} catch (e) {
				console.warn('关闭旧WebSocket连接时出错:', e);
			}
		}
		
		// 设置连接超时（10秒）
		const connectTimeout = setTimeout(() => {
			if (ws && ws.readyState === WebSocket.CONNECTING) {
				console.warn('⚠️ WebSocket 连接超时，可能服务器不支持 WebSocket');
				ws.close();
				updateConnectionStatus(false);
				// 不再重试，避免无限重连
			}
		}, 10000);
		
		ws = new WebSocket(wsUrl);
		
		ws.onopen = () => {
			console.log('✅ WebSocket 已连接');
			clearTimeout(connectTimeout);
			clearTimeout(wsReconnectTimer);
			updateConnectionStatus(true);
		};
		
		ws.onmessage = (event) => {
			try {
				const message = JSON.parse(event.data);
				handleWebSocketMessage(message);
			} catch (error) {
				console.error('WebSocket 消息解析失败:', error);
			}
		};
		
		ws.onerror = (error) => {
			console.error('WebSocket 错误:', error);
			clearTimeout(connectTimeout);
			updateConnectionStatus(false);
		};
		
		ws.onclose = (event) => {
			clearTimeout(connectTimeout);
			console.log('WebSocket 已断开', event.code, event.reason || '');
			updateConnectionStatus(false);
			
			// 如果服务器不支持 WebSocket（连接被拒绝），不再重试
			if (event.code === 1006 || event.code === 1002) {
				console.warn('⚠️ 服务器可能不支持 WebSocket，将使用轮询方式更新数据');
				// 不再重试 WebSocket 连接
				return;
			}
			
			// 其他情况，5秒后尝试重连（最多重试3次）
			if (event.code !== 1000 && (!window.wsReconnectCount || window.wsReconnectCount < 3)) {
				window.wsReconnectCount = (window.wsReconnectCount || 0) + 1;
				console.log(`🔄 ${window.wsReconnectCount}/3 次重连尝试...`);
				wsReconnectTimer = setTimeout(() => {
					initWebSocket();
				}, 5000);
			} else if (window.wsReconnectCount >= 3) {
				console.warn('⚠️ WebSocket 重连次数已达上限，将使用轮询方式更新数据');
				window.wsReconnectCount = 0; // 重置计数器
			}
		};
		
		// 心跳保持连接（只设置一次）
		if (!window.wsHeartbeatInterval) {
			window.wsHeartbeatInterval = setInterval(() => {
				if (ws && ws.readyState === WebSocket.OPEN) {
					try {
						ws.send(JSON.stringify({ type: 'ping' }));
					} catch (error) {
						console.error('发送心跳失败:', error);
					}
				}
			}, 30000); // 每30秒发送一次 ping
		}
		
	} catch (error) {
		console.error('WebSocket 初始化失败:', error);
		updateConnectionStatus(false);
		// 如果URL解析失败，不再重试
		console.warn('⚠️ WebSocket URL 配置错误，将使用轮询方式更新数据');
	}
}

// 更新连接状态显示
function updateConnectionStatus(connected) {
	const statusIndicator = document.querySelector('.status-indicator');
	if (statusIndicator) {
		const statusDot = statusIndicator.querySelector('.status-dot');
		if (statusDot) {
			statusDot.style.backgroundColor = connected ? '#4CAF50' : '#f44336';
		}
	}
}

// 处理 WebSocket 消息
function handleWebSocketMessage(message) {
	console.log('📨 收到WebSocket消息:', message.type, message.data);
	
	switch (message.type) {
		case 'connected':
			console.log('✅', message.message);
			break;
		case 'state':
			// 初始状态同步
			updateDashboardFromState(message.data);
			if (message.data.liveStatus) {
				globalState.isLive = true;
			}
			if (message.data.votes) {
				globalState.currentVotes = message.data.votes;
			}
			break;
		case 'live-started':
			// 直播开始
			const lastStopTime2 = window.lastStopLiveTime || 0;
			const timeSinceStop2 = Date.now() - lastStopTime2;
			if (timeSinceStop2 < 3000) { // 3秒内忽略开始消息
				console.log('⚠️ 刚刚停止直播，忽略 live-started 消息，防止误触发');
				break;
			}
			globalState.isLive = true;
			globalState.liveId = message.data.liveId;
			updateLiveStatus({ status: 'started', streamUrl: message.data.streamUrl });
			showNotification('直播已开始', 'success');
			loadDashboard();
			// 实时更新所有流状态列表（支持多流）
			loadAllStreamsStatus();
			loadLiveSetup();
			break;
		case 'live-stopped':
			// 直播停止
			globalState.isLive = false;
			globalState.liveId = null;
			updateLiveStatus({ status: 'stopped' });
			showNotification('直播已停止', 'info');
			loadDashboard();
			// 实时更新所有流状态列表（支持多流）
			loadAllStreamsStatus();
			loadLiveSetup();
			break;
		case 'votes-updated':
			// 投票数据更新：票数管理页仅当当前选中的流与消息 streamId 一致时更新
			const msgStreamId = message.data?.streamId;
			const votesStreamSelect = document.getElementById('votes-stream-select');
			const currentVotesStreamId = votesStreamSelect ? votesStreamSelect.value : null;
			if (!msgStreamId || msgStreamId === currentVotesStreamId) {
				globalState.currentVotes = {
					leftVotes: message.data.leftVotes,
					rightVotes: message.data.rightVotes
				};
				const total = (message.data.leftVotes || 0) + (message.data.rightVotes || 0);
				updateVotesDisplay({
					leftVotes: message.data.leftVotes,
					rightVotes: message.data.rightVotes,
					totalVotes: message.data.totalVotes || total,
					leftPercentage: total > 0 ? Math.round(((message.data.leftVotes || 0) / total) * 100) : 50,
					rightPercentage: total > 0 ? Math.round(((message.data.rightVotes || 0) / total) * 100) : 50
				});
			}
			// 立即更新该流卡片上的总票数：直播中用本场票数（与大屏一致），否则用当前票数
			if (msgStreamId) {
				const hasSession = message.data.liveSessionLeft != null && message.data.liveSessionRight != null;
				const cardTotal = hasSession
					? (message.data.liveSessionLeft || 0) + (message.data.liveSessionRight || 0)
					: (message.data.leftVotes || 0) + (message.data.rightVotes || 0);
				const numEl = document.querySelector(`.stream-total-votes[data-stream-id="${msgStreamId}"] .stream-total-votes-num`);
				if (numEl) numEl.textContent = cardTotal;
			}
			// 用户/模拟/动态投票时：刷新用户列表，并向投票趋势图追加一点（带真实时间戳，非 00:00:00）
			if (message.data?.source === 'user' || message.data?.source === 'mock' || message.data?.source === 'dynamic') {
				if (typeof loadUsers === 'function') loadUsers();
				const left = message.data.liveSessionLeft != null ? message.data.liveSessionLeft : message.data.leftVotes;
				const right = message.data.liveSessionRight != null ? message.data.liveSessionRight : message.data.rightVotes;
				if (typeof appendVoteTrendPoint === 'function') appendVoteTrendPoint(left, right);
			}
			// 关播或票数重置后刷新数据统计的投票分析图（含 Mock 关播 mock-live-end）
			if (message.data?.source === 'live-end-reset' || message.data?.source === 'stop' || message.data?.source === 'mock-live-end') {
				if (typeof refreshStatisticsBarChartFromToday === 'function') refreshStatisticsBarChartFromToday();
			}
			break;
		case 'ai-started':
			// AI识别启动 - 🔧 修复：只更新匹配的流
			{
				const messageStreamId = message.data.streamId;
				const currentStreamId = document.getElementById('ai-stream-select')?.value;
				
				console.log('📨 收到 AI 启动消息:', { messageStreamId, currentStreamId });
				
				// 只有当消息的 streamId 与当前选中的流匹配时，才更新按钮
				if (!currentStreamId || messageStreamId === currentStreamId) {
					globalState.aiStatus = 'running';
					globalState.aiSessionId = message.data.aiSessionId;
					if (typeof updateAIControlButtons === 'function') {
						updateAIControlButtons('running');
					}
					showNotification(`AI识别已启动 (流: ${messageStreamId || 'default'})`, 'success');
				}
				if (messageStreamId) {
					window.streamAIStatusesMap = window.streamAIStatusesMap || {};
					window.streamAIStatusesMap[messageStreamId] = 'running';
					if (typeof renderMultiLiveOverview === 'function') renderMultiLiveOverview();
				}
				if (currentStreamId && messageStreamId !== currentStreamId) {
					console.log('⚠️ AI 启动消息被忽略（streamId 不匹配）');
				}
			}
			break;
		case 'ai-stopped':
			// AI识别停止 - 🔧 修复：只更新匹配的流
			{
				const messageStreamId = message.data.streamId;
				const currentStreamId = document.getElementById('ai-stream-select')?.value;
				
				console.log('📨 收到 AI 停止消息:', { messageStreamId, currentStreamId });
				
				// 只有当消息的 streamId 与当前选中的流匹配时，才更新按钮
				if (!currentStreamId || messageStreamId === currentStreamId) {
					globalState.aiStatus = 'stopped';
					globalState.aiSessionId = null;
					if (typeof updateAIControlButtons === 'function') {
						updateAIControlButtons('stopped');
					}
					showNotification(`AI识别已停止 (流: ${messageStreamId || 'default'})`, 'info');
				}
				if (messageStreamId) {
					window.streamAIStatusesMap = window.streamAIStatusesMap || {};
					window.streamAIStatusesMap[messageStreamId] = 'stopped';
					if (typeof renderMultiLiveOverview === 'function') renderMultiLiveOverview();
				}
				if (currentStreamId && messageStreamId !== currentStreamId) {
					console.log('⚠️ AI 停止消息被忽略（streamId 不匹配）');
				}
			}
			break;
		case 'ai-status-changed':
			// AI状态变更 - 🔧 修复：只更新匹配的流
			{
				const messageStreamId = message.data.streamId;
				const currentStreamId = document.getElementById('ai-stream-select')?.value;
				
				console.log('📨 收到 AI 状态变更消息:', { messageStreamId, currentStreamId, status: message.data.status });
				
				// 只有当消息的 streamId 与当前选中的流匹配时，才更新按钮
				if (!currentStreamId || messageStreamId === currentStreamId) {
					globalState.aiStatus = message.data.status;
					if (typeof updateAIControlButtons === 'function') {
						updateAIControlButtons(message.data.status);
					}
					showNotification(`AI识别已${message.data.status === 'paused' ? '暂停' : '恢复'} (流: ${messageStreamId || 'default'})`, 'info');
				} else {
					console.log('⚠️ AI 状态变更消息被忽略（streamId 不匹配）');
				}
			}
			break;
		case 'viewersCount':
			// 观看人数推送
			{
				const { streamId, data } = message;
				const { count, action } = data || {};
				
				console.log(`👥 收到观看人数推送: 流 ${streamId}, 人数 ${count}, 动作: ${action}`);
				
				// 更新 globalState（如果是当前流）
				if (globalState.currentStreamId === streamId || !globalState.currentStreamId) {
					globalState.viewersCount = count;
				}
				
				// 触发UI更新
				if (typeof updateViewersDisplay === 'function') {
					updateViewersDisplay(streamId, count, action);
				}
				
				// 如果是多直播总览页面，更新相应流的观看人数
				if (typeof updateStreamViewersInList === 'function') {
					updateStreamViewersInList(streamId, count);
				}
				
				// 根据动作显示不同的提示
				const actionText = {
					'user_joined': '用户加入',
					'user_left': '用户离开',
					'live_started': '直播开始',
					'live_stopped': '直播结束',
					'manual_broadcast': '手动广播'
				}[action] || '更新';
				
				// 可选：显示通知（可根据需要注释掉）
				// showNotification(`${actionText}: 观看人数 ${count}`, 'info');
			}
			break;
		case 'ai-content-added':
			// AI内容添加
			showNotification('新的AI内容已生成', 'info');
			if (document.getElementById('ai-content').classList.contains('active')) {
				loadAIContent();
			}
			break;
		case 'ai-content-deleted':
			// AI内容删除
			showNotification('AI内容已删除', 'info');
			if (document.getElementById('ai-content').classList.contains('active')) {
				loadAIContent();
			}
			break;
		case 'vote-updated':
			// 实时投票更新（兼容旧格式）
			if (message.data.votes) {
				updateVotesDisplay(message.data.votes);
			}
			break;
		case 'live-status-changed':
		case 'liveStatus':
			// 直播状态变化（兼容旧格式）
			// 检查是否刚刚停止直播，如果是，忽略状态更新（防止误触发）
			const lastStopTime = window.lastStopLiveTime || 0;
			const timeSinceStop = Date.now() - lastStopTime;
			if (timeSinceStop < 3000) { // 3秒内忽略状态更新
				console.log('⚠️ 刚刚停止直播，忽略状态更新消息，防止误触发');
				break;
			}
			updateLiveStatus(message.data);
			// 直播开始时：设置投票趋势图起始时间，使后续投票点时间戳为真实经过时间（非 00:00:00）
			if (message.data?.status === 'started' || message.data?.isLive === true) {
				if (typeof resetVoteTrendOnLiveStart === 'function') resetVoteTrendOnLiveStart();
			}
			// 直播停止时刷新数据统计的投票分析图（当日累计数据已保存）
			if (message.data?.isLive === false || message.data?.status === 'stopped') {
				if (typeof refreshStatisticsBarChartFromToday === 'function') refreshStatisticsBarChartFromToday();
			}
			// 直播开始/停止时刷新多直播卡片
			if (typeof renderMultiLiveOverview === 'function') renderMultiLiveOverview();
			// 实时更新所有流状态列表
			if (document.getElementById('live-setup') && document.getElementById('live-setup').classList.contains('active')) {
				loadAllStreamsStatus();
			}
			loadLiveSetup();
			break;
		case 'debate-updated':
			// 辩论设置更新
			updateDebateSettings(message.data.debate);
			break;
		case 'live-schedule-updated':
			// 直播计划更新
			if (document.getElementById('live-setup').classList.contains('active')) {
				loadLiveSetup();
			}
			loadLiveStatus();
			break;
		case 'live-schedule-cancelled':
			// 直播计划取消
			if (document.getElementById('live-setup').classList.contains('active')) {
				loadLiveSetup();
			}
			loadLiveStatus();
			break;
		case 'ai-content-added':
		case 'ai-content-updated':
			// AI 内容添加/更新
			if (document.getElementById('ai-content').classList.contains('active')) {
				loadAIContent();
			}
			break;
		case 'ai-content-deleted':
			// AI 内容删除
			if (document.getElementById('ai-content').classList.contains('active')) {
				loadAIContent();
			}
			break;
		case 'stream-online-update':
			// 每个直播流在线人数有增有降，实时更新卡片上的在线人数
			{
				const counts = message.data?.streamOnlineCounts || {};
				document.querySelectorAll('.stream-online-count').forEach(el => {
					const sid = el.getAttribute('data-stream-id');
					if (sid && counts[sid] != null) {
						const numEl = el.querySelector('.stream-online-num');
						if (numEl) numEl.textContent = counts[sid];
					}
				});
			}
			break;
		case 'pong':
			// 心跳响应
			break;
		default:
			console.log('未知的 WebSocket 消息类型:', message.type);
	}
}

// 从状态更新仪表板
function updateDashboardFromState(data) {
	if (data.votes) {
		updateVotesDisplay(data.votes);
	}
	if (data.dashboard) {
		updateDashboardDisplay(data.dashboard);
	}
	if (data.debate) {
		// 如果当前在辩论设置页面，更新表单
		const debatePage = document.getElementById('debate');
		if (debatePage && debatePage.classList.contains('active')) {
			updateDebateForm(data.debate);
		}
	}
}

// 更新投票显示
function updateVotesDisplay(votes) {
	// 数据概览页使用 Mock 时，总投票数只由 updateMockGlobalStats 更新，避免双数字/闪烁
	const useMock = typeof mockGetGlobalDisplayData === 'function';
	if (!useMock) {
		const totalVotesEl = document.getElementById('total-votes');
		if (totalVotesEl && (votes.globalTotalVotes != null || votes.allTotalVotes != null)) {
			const globalTotal = votes.globalTotalVotes ?? votes.allTotalVotes;
			const cur = parseInt(totalVotesEl.textContent, 10) || 0;
			const totalVotes = (globalTotal != null && globalTotal >= 0) ? globalTotal : cur;
			if (totalVotes > 0 || cur === 0) totalVotesEl.textContent = totalVotes;
		}
	}
	updateVotesChart(votes);
}

// 更新直播状态
function updateLiveStatus(data) {
	// 数据概览页使用 Mock 时，直播状态只由 updateMockGlobalStats 更新，避免与 WebSocket 交替导致闪烁
	const dashboardPage = document.getElementById('dashboard');
	const useMock = dashboardPage && dashboardPage.classList.contains('active') && typeof mockGetGlobalDisplayData === 'function';

	const statusText = document.getElementById('live-status-text');
	const liveStatusEl = document.getElementById('live-status');
	// 支持两种格式：1. { status: 'started'|'stopped' }  2. { isLive: true|false }
	let isStarted = false;
	if (data.status === 'started' || data.isLive === true) {
		isStarted = true;
	} else if (data.status === 'stopped' || data.isLive === false) {
		isStarted = false;
	}

	if (isStarted) {
		currentLiveStatus = true;
		globalState.isLive = true;
		if (!useMock) {
			if (statusText) statusText.textContent = '直播中';
			if (liveStatusEl) {
				liveStatusEl.innerHTML = '<span style="color: #27ae60;">直播中</span>';
			}
		}
		showNotification('直播已开始', 'success');
		console.log('✅ [状态更新] 直播已开始');
	} else {
		currentLiveStatus = false;
		globalState.isLive = false;
		if (!useMock) {
			if (statusText) statusText.textContent = '未直播';
			if (liveStatusEl) {
				liveStatusEl.innerHTML = '<span style="color: #95a5a6;">未直播</span>';
			}
		}
		showNotification('直播已停止', 'info');
		console.log('✅ [状态更新] 直播已停止');
	}
	
	// 更新多直播状态缓存
	if (data.streamId || data.liveId) {
		const streamId = data.streamId || data.liveId;
		
		if (!window.multiLiveState) {
			window.multiLiveState = { streams: {}, activeStreams: [], lastUpdate: Date.now() };
		}
		
		// 更新流状态
		if (!window.multiLiveState.streams[streamId]) {
			window.multiLiveState.streams[streamId] = {};
		}
		window.multiLiveState.streams[streamId].isLive = isStarted;
		window.multiLiveState.streams[streamId].lastUpdate = Date.now();
		
		// 更新活跃流列表
		if (isStarted) {
			if (!window.multiLiveState.activeStreams.includes(streamId)) {
				window.multiLiveState.activeStreams.push(streamId);
			}
		} else {
			window.multiLiveState.activeStreams = window.multiLiveState.activeStreams.filter(id => id !== streamId);
		}
		
		console.log(`🔄 多流状态更新: 流 ${streamId} -> ${isStarted ? '直播中' : '已停止'}`);
		console.log(`📊 当前活跃流: ${window.multiLiveState.activeStreams.length} 个`, window.multiLiveState.activeStreams);
		
		// 如果在Dashboard页面，刷新多直播总览
		const dashboardPage = document.getElementById('dashboard');
		if (dashboardPage && dashboardPage.classList.contains('active')) {
			setTimeout(() => {
				console.log('🔄 WebSocket状态变更，刷新多直播总览');
				if (typeof renderMultiLiveOverview === 'function') {
					renderMultiLiveOverview();
				}
			}, 500); // 延迟500ms，等待后端状态完全同步
		}
		
		// 如果在直播控制页面，也刷新流状态列表
		const liveSetupPage = document.getElementById('live-setup');
		if (liveSetupPage && liveSetupPage.classList.contains('active')) {
			setTimeout(() => {
				if (typeof loadAllStreamsStatus === 'function') {
					loadAllStreamsStatus();
				}
			}, 500);
		}
	}
	
	// 如果有提供 updateLiveStatusUI 函数，也调用它
	if (typeof updateLiveStatusUI === 'function') {
		updateLiveStatusUI(isStarted);
	}
}

// 更新辩论设置
function updateDebateSettings(debate) {
	updateDebateForm(debate);
	showNotification('辩论设置已更新', 'success');
}

// 更新辩论表单
function updateDebateForm(debate) {
	if (!debate) return;
	
	const titleInput = document.getElementById('debate-title');
	const descInput = document.getElementById('debate-description');
	const leftInput = document.getElementById('left-position');
	const rightInput = document.getElementById('right-position');
	
	if (titleInput) titleInput.value = debate.title || '';
	if (descInput) descInput.value = debate.description || '';
	if (leftInput) leftInput.value = debate.leftPosition || '';
	if (rightInput) rightInput.value = debate.rightPosition || '';
}

// 更新仪表板显示（数据概览页使用 Mock 数据，不覆盖）
function updateDashboardDisplay(dashboard) {
	// 数据概览页使用纯前端 Mock，不覆盖 Mock 数据
	const dashboardPage = document.getElementById('dashboard');
	if (dashboardPage && dashboardPage.classList.contains('active') && typeof mockGetGlobalDisplayData === 'function') {
		if (typeof updateMockGlobalStats === 'function') updateMockGlobalStats();
		return;
	}
	if (!dashboard) return;
	
	const totalUsersEl = document.getElementById('total-users');
	const liveStatusEl = document.getElementById('live-status');
	const totalVotesEl = document.getElementById('total-votes');
	const activeUsersEl = document.getElementById('active-users');
	const liveStatusTextEl = document.getElementById('live-status-text');
	
	if (totalUsersEl) totalUsersEl.textContent = dashboard.totalUsers || 0;
	if (liveStatusEl) {
		liveStatusEl.innerHTML = dashboard.isLive 
			? '<span style="color: #27ae60;">直播中</span>' 
			: '<span style="color: #95a5a6;">未直播</span>';
	}
	if (totalVotesEl) {
		const globalTotal = dashboard.globalTotalVotes ?? dashboard.allTotalVotes;
		const cur = parseInt(totalVotesEl.textContent, 10) || 0;
		const val = (globalTotal != null && globalTotal >= 0) ? globalTotal : cur;
		if (val > 0 || cur === 0) totalVotesEl.textContent = val;
	}
	if (activeUsersEl) activeUsersEl.textContent = dashboard.activeUsers || 0;
	if (liveStatusTextEl) liveStatusTextEl.textContent = dashboard.isLive ? '直播中' : '未直播';
}

// 实时投票趋势图：
let votesChartInstance = null;
let voteTrendData = { labels: [], left: [], right: [] };
let voteTrendLiveStartTime = null;
const VOTE_TREND_MAX_POINTS = 30;
const VOTE_CHART_Y_MAX = 80;
const VOTE_CHART_Y_STEP = 20;

function formatVoteTrendTime(seconds) {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = Math.floor(seconds % 60);
	return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
}

function initVotesChart() {
	const canvas = document.getElementById('votes-chart');
	if (!canvas || typeof Chart === 'undefined') return;
	const ctx = canvas.getContext('2d');
	if (votesChartInstance) {
		votesChartInstance.destroy();
		votesChartInstance = null;
	}
	if (voteTrendData.labels.length === 0) {
		voteTrendData = { labels: ['00:00:00'], left: [0], right: [0] };
	}
	votesChartInstance = new Chart(ctx, {
		type: 'line',
		data: {
			labels: voteTrendData.labels.slice(),
			datasets: [
				{ label: '正方', data: voteTrendData.left.slice(), borderColor: '#3498db', backgroundColor: 'rgba(52,152,219,0.1)', fill: true, tension: 0.4, pointRadius: 3, pointHoverRadius: 5 },
				{ label: '反方', data: voteTrendData.right.slice(), borderColor: '#e74c3c', backgroundColor: 'rgba(231,76,60,0.1)', fill: true, tension: 0.4, pointRadius: 3, pointHoverRadius: 5 }
			]
		},
		options: {
			responsive: true,
			maintainAspectRatio: true,
			layout: { padding: { top: 6, right: 6, bottom: 6, left: 6 } },
			animation: false,
			interaction: { mode: 'index', intersect: false },
			plugins: {
				legend: { position: 'top' },
				tooltip: {
					callbacks: {
						title: function(items) {
							const i = items[0]?.dataIndex;
							return (i != null && voteTrendData.labels[i]) ? '时间 ' + voteTrendData.labels[i] : '';
						},
						label: function(context) {
							const i = context.dataIndex;
							const left = voteTrendData.left[i] ?? 0;
							const right = voteTrendData.right[i] ?? 0;
							if (context.datasetIndex === 0) return '正方: ' + left + ' 票';
							return '反方: ' + right + ' 票';
						}
					}
				}
			},
			scales: {
				y: { beginAtZero: true, max: VOTE_CHART_Y_MAX, stepSize: VOTE_CHART_Y_STEP, title: { display: true, text: '票数' }, grace: '5%' },
				x: { title: { display: true, text: '时间' }, ticks: { maxTicksLimit: 10 } }
			}
		}
	});
}

function startVoteChartTimer() {
	// 不再用定时器新增点，仅由 appendVoteTrendPoint（每次投票时）新增
}

// 开播时：记录本次直播开始时间；若图表为空则加入初始点 (0,0)，否则在新会话右侧加一点 00:00:00(上一刻票数) 使折线连续
function resetVoteTrendOnLiveStart() {
	voteTrendLiveStartTime = Date.now();
	if (voteTrendData.labels.length === 0) {
		voteTrendData.labels.push('00:00:00');
		voteTrendData.left.push(0);
		voteTrendData.right.push(0);
	} else {
		const lastL = voteTrendData.left[voteTrendData.left.length - 1] ?? 0;
		const lastR = voteTrendData.right[voteTrendData.right.length - 1] ?? 0;
		voteTrendData.labels.push('00:00:00');
		voteTrendData.left.push(lastL);
		voteTrendData.right.push(lastR);
		while (voteTrendData.labels.length > VOTE_TREND_MAX_POINTS) {
			voteTrendData.labels.shift();
			voteTrendData.left.shift();
			voteTrendData.right.shift();
		}
	}
	if (votesChartInstance) {
		votesChartInstance.data.labels = voteTrendData.labels.slice();
		votesChartInstance.data.datasets[0].data = voteTrendData.left.slice();
		votesChartInstance.data.datasets[1].data = voteTrendData.right.slice();
		votesChartInstance.update('none');
	}
}
if (typeof window !== 'undefined') window.resetVoteTrendOnLiveStart = resetVoteTrendOnLiveStart;

// 每产生一次投票时调用：在右侧新增一个数据点；超30个仅删最左；不触发页面滚动
function appendVoteTrendPoint(leftVotes, rightVotes) {
	if (!voteTrendData.labels || !votesChartInstance) return;
	const left = leftVotes ?? 0;
	const right = rightVotes ?? 0;
	const label = voteTrendLiveStartTime != null
		? formatVoteTrendTime((Date.now() - voteTrendLiveStartTime) / 1000)
		: (voteTrendData.labels.length > 0 ? voteTrendData.labels[voteTrendData.labels.length - 1] : '00:00:00');
	voteTrendData.labels.push(label);
	voteTrendData.left.push(left);
	voteTrendData.right.push(right);
	while (voteTrendData.labels.length > VOTE_TREND_MAX_POINTS) {
		voteTrendData.labels.shift();
		voteTrendData.left.shift();
		voteTrendData.right.shift();
	}
	votesChartInstance.data.labels = voteTrendData.labels.slice();
	votesChartInstance.data.datasets[0].data = voteTrendData.left.slice();
	votesChartInstance.data.datasets[1].data = voteTrendData.right.slice();
	if (votesChartInstance.options.scales?.y) {
		const dataMax = (voteTrendData.left.length && voteTrendData.right.length)
			? Math.max(...voteTrendData.left, ...voteTrendData.right, 0) + 5
			: VOTE_CHART_Y_MAX;
		const max = Math.min(VOTE_CHART_Y_MAX, Math.max(VOTE_CHART_Y_STEP, Math.ceil(dataMax / VOTE_CHART_Y_STEP) * VOTE_CHART_Y_STEP));
		votesChartInstance.options.scales.y.max = max;
		votesChartInstance.options.scales.y.stepSize = VOTE_CHART_Y_STEP;
	}
	votesChartInstance.update('none');
}
if (typeof window !== 'undefined') window.appendVoteTrendPoint = appendVoteTrendPoint;

function updateVotesChart(votes) {
	const isLive = votes?.isLive ?? window.globalState?.isLive ?? false;
	if (!isLive) return;
	// 仅在有投票事件时由 mock 调用 appendVoteTrendPoint 新增点；此处仅做最后一点同步（兼容旧逻辑）
	if (votes && voteTrendData.labels.length > 0 && (votes.leftVotes !== undefined || votes.rightVotes !== undefined)) {
		const last = voteTrendData.labels.length - 1;
		voteTrendData.left[last] = votes.leftVotes ?? voteTrendData.left[last];
		voteTrendData.right[last] = votes.rightVotes ?? voteTrendData.right[last];
		if (votesChartInstance) {
			votesChartInstance.data.datasets[0].data[last] = voteTrendData.left[last];
			votesChartInstance.data.datasets[1].data[last] = voteTrendData.right[last];
			votesChartInstance.update('none');
		}
	}
}

// 初始化导航
function initNavigation() {
	const navItems = document.querySelectorAll('.nav-item');
	const pages = document.querySelectorAll('.page');
	const pageTitle = document.querySelector('.page-title');

	navItems.forEach(item => {
		item.addEventListener('click', (e) => {
			e.preventDefault();
			const targetPage = item.getAttribute('data-page');
			
			// 更新导航状态
			navItems.forEach(nav => nav.classList.remove('active'));
			item.classList.add('active');
			
			// 切换页面
			pages.forEach(page => page.classList.remove('active'));
			document.getElementById(targetPage).classList.add('active');
			
			// 更新标题
			const titles = {
				'dashboard': '数据概览',
				'stream-manage': '直播流管理',
				'live-setup': '直播设置',
				'users': '用户管理',
				'votes': '票数管理',
				'judges': '评委管理',
				'debate-flow': '辩论流程',
				'ai-content': 'AI 内容管理',
				'statistics': '数据统计'
			};
			pageTitle.textContent = titles[targetPage] || '管理后台';
			
			// 加载对应页面数据
			loadPageData(targetPage);
		});
	});
}

// 加载页面数据
function loadPageData(page) {
	if (page !== 'statistics' && typeof onLeaveStatisticsPage === 'function') {
		onLeaveStatisticsPage();
	}
	// 清理流状态刷新定时器（切换到其他页面时）
	if (page !== 'live-setup' && window.streamsStatusRefreshTimer) {
		clearInterval(window.streamsStatusRefreshTimer);
		window.streamsStatusRefreshTimer = null;
	}
	
	switch(page) {
		case 'dashboard':
			loadDashboard();
			// Mock 模式：初始化投票趋势图（未直播时静止，直播时每 3 秒更新）
			if (typeof initVotesChart === 'function') initVotesChart();
			if (typeof startVoteChartTimer === 'function') startVoteChartTimer();
			break;
		case 'live-setup':
			loadLiveSetup(); // 这个函数会调用 loadStreamsToSelect() 和启动定时刷新
			break;
		case 'users':
			loadUsers();
			break;
		case 'votes':
			// 进入票数管理页：先刷新流列表，加载完成后再根据选中流加载票数
			if (typeof loadVotesStreamsList === 'function') {
				loadVotesStreamsList().then(() => {
					const sel = document.getElementById('votes-stream-select');
					if (sel && sel.value && typeof loadVotesByStream === 'function') loadVotesByStream(sel.value);
				});
			}
			if (currentLiveStatus) startVotesAutoRefresh();
			else stopVotesAutoRefresh();
			break;
		case 'stream-manage':
			loadStreamsList();
			break;
		case 'judges':
			if (typeof loadStreamsForJudges === 'function') loadStreamsForJudges();
			if (typeof populateAllJudgeUserSelects === 'function') populateAllJudgeUserSelects();
			// 若已有选中的流，加载其评委
			setTimeout(() => {
				const sel = document.getElementById('judges-stream-select');
				if (sel?.value && typeof loadJudgesDataForStream === 'function') {
					loadJudgesDataForStream(sel.value);
				}
			}, 300);
			break;
		case 'debate-flow':
			if (typeof loadDebateFlowStreamsList === 'function') {
				loadDebateFlowStreamsList();
			}
			break;
		case 'ai-content':
			loadAIContent();
			// 🔧 新增：初始化时查询当前选中流的 AI 状态
			setTimeout(() => {
				const aiStreamSelect = document.getElementById('ai-stream-select');
				const streamId = aiStreamSelect?.value;
				if (streamId && typeof updateAIStatusForStream === 'function') {
					console.log('🔄 AI 内容管理页初始化，查询流', streamId, '的 AI 状态');
					updateAIStatusForStream(streamId);
				}
			}, 500); // 延迟 500ms，等待页面元素加载完成
			break;
		case 'statistics':
			loadStatistics();
			break;
	}
}

// ==================== 数据概览 ====================
// 保证 35 个 mock 用户（进入数据概览时）
async function ensureMockUsers35() {
	if (typeof seedMockUsers !== 'function') return;
	try {
		await seedMockUsers();
	} catch (e) {
		console.warn('ensureMockUsers35:', e);
	}
}

async function loadDashboard() {
	try {
		await ensureMockUsers35();
		// 🔧 修复：根据选择的流加载对应的 Dashboard 数据
		const streamSelect = document.getElementById('stream-select');
		const selectedStreamId = streamSelect?.value;
		
		// 🔧 修复：统一使用 fetchDashboard，它会自动处理 streamId
		console.log(`📊 加载 Dashboard 数据...`, selectedStreamId ? `流: ${selectedStreamId}` : '使用默认流');
		const result = await fetchDashboard(selectedStreamId);
		
		// 处理返回格式：可能是 {success, data} 或直接是数据
		let data;
		if (result && result.success === false) {
			console.error('❌ Dashboard 加载失败:', result.message);
			// 显示错误提示
			const errorMsg = result.message || '加载 Dashboard 失败';
			if (typeof showNotification === 'function') {
				showNotification(errorMsg, 'error');
			}
			return;
		} else if (result && result.data) {
			// {success: true, data: {...}} 格式
			data = result.data;
		} else {
			// 直接返回数据格式
			data = result;
		}
		
		if (!data) {
			console.warn('⚠️ Dashboard 数据为空');
			return;
		}
		
		// 更新直播状态
		if (data.isLive !== undefined) {
			currentLiveStatus = data.isLive;
			globalState.isLive = data.isLive; // 同时更新 globalState，确保按钮状态正确
		}
		
		document.getElementById('total-users').textContent = data.totalUsers || 0;
		const liveStatusEl = document.getElementById('live-status');
		if (liveStatusEl) {
			liveStatusEl.innerHTML = data.isLive 
				? '<span style="color: #27ae60;">直播中</span>' 
				: '<span style="color: #95a5a6;">未直播</span>';
		}
		// 紫色导航栏总投票数
		const useMockForDashboard = typeof mockGetGlobalDisplayData === 'function';
		if (!useMockForDashboard) {
			const totalEl = document.getElementById('total-votes');
			if (totalEl) {
				const globalTotal = data.globalTotalVotes ?? data.allTotalVotes;
				const cur = parseInt(totalEl.textContent, 10) || 0;
				const val = (globalTotal != null && globalTotal >= 0) ? globalTotal : cur;
				if (val > 0 || cur === 0) totalEl.textContent = val;
			}
		}
		document.getElementById('active-users').textContent = data.activeUsers || 0;
		document.getElementById('live-status-text').textContent = data.isLive ? '直播中' : '未直播';
		
		// 右上角「开始直播」按钮仅由用户点击切换，不随 isLive 变化
		
		// 更新票数显示
		if (data.leftVotes !== undefined && data.rightVotes !== undefined) {
			globalState.currentVotes = {
				leftVotes: data.leftVotes,
				rightVotes: data.rightVotes
			};
		}
		
		// 更新AI状态
		if (data.aiStatus) {
			globalState.aiStatus = data.aiStatus;
			if (typeof updateAIControlButtons === 'function') {
				updateAIControlButtons(data.aiStatus);
			}
		}
		
		// 🔧 新增：初始化观看人数
		if (data.streamId && typeof initViewersCount === 'function') {
			await initViewersCount(data.streamId);
		}
		if (typeof initVotesChart === 'function') initVotesChart();
	} catch (error) {
		console.error('加载概览数据失败:', error);
	}
}

// 数据概览页：在线用户实时 mock 定时器（每 2.5 秒更新）
let dashboardMockTimerId = null;
function startDashboardMockTimers() {
	// 已废弃：在线人数由后端统一分配，避免前端随机覆盖
	return;
}
function stopDashboardMockTimers() {
	if (dashboardMockTimerId) {
		clearInterval(dashboardMockTimerId);
		dashboardMockTimerId = null;
	}
}

async function updateDashboard() {
	if (document.getElementById('dashboard').classList.contains('active')) {
		await loadDashboard();
	}
}

// ==================== 直播流管理 ====================
async function loadStreams() {
	try {
		const response = await fetch(`${API_BASE}/streams`);
		const streams = await response.json();
		
		const streamList = document.getElementById('stream-list');
		streamList.innerHTML = '';
		
		if (streams.length === 0) {
			streamList.innerHTML = '<div class="empty-state">暂无直播流，点击"添加直播流"开始</div>';
			return;
		}
		
		streams.forEach(stream => {
			const streamCard = createStreamCard(stream);
			streamList.appendChild(streamCard);
		});
	} catch (error) {
		console.error('加载直播流失败:', error);
		showNotification('加载失败', 'error');
	}
}

function createStreamCard(stream) {
	const card = document.createElement('div');
	card.className = 'stream-card';
	card.innerHTML = `
		<div class="stream-card-header">
			<h3>${stream.name}</h3>
			<div class="stream-status ${stream.enabled ? 'enabled' : 'disabled'}">
				<span class="status-dot"></span>
				${stream.enabled ? '已启用' : '已禁用'}
			</div>
		</div>
		<div class="stream-card-body">
			<div class="stream-info">
				<label>流地址:</label>
				<code class="stream-url">${stream.url}</code>
			</div>
			<div class="stream-info">
				<label>类型:</label>
				<span class="stream-type">${stream.type.toUpperCase()}</span>
			</div>
			<div class="stream-info">
				<label>创建时间:</label>
				<span>${new Date(stream.createdAt).toLocaleString()}</span>
			</div>
		</div>
		<div class="stream-card-actions">
			<button class="btn btn-sm btn-primary" onclick='editStream("${stream.id}")'>编辑</button>
			<button class="btn btn-sm btn-secondary" onclick='toggleStream("${stream.id}")'>
				${stream.enabled ? '禁用' : '启用'}
			</button>
			<button class="btn btn-sm btn-danger" onclick='deleteStream("${stream.id}")'>删除</button>
		</div>
	`;
	return card;
}


async function editStream(id) {
	if (typeof openEditStreamModal === 'function') {
		openEditStreamModal(id);
	} else {
		console.error('openEditStreamModal 函数未定义，请确保 stream-management.js 已加载');
		showNotification('编辑功能不可用，请刷新页面重试', 'error');
	}
}

async function toggleStream(id) {
	try {
		const response = await fetch(`${API_BASE}/streams/${id}/toggle`, {
			method: 'POST'
		});
		if (response.ok) {
			showNotification('操作成功', 'success');
			loadStreams();
		}
	} catch (error) {
		console.error('操作失败:', error);
		showNotification('操作失败', 'error');
	}
}

async function deleteStream(id) {
	if (!confirm('确定要删除这个直播流吗？')) return;
	
	try {
		const response = await fetch(`${API_BASE}/streams/${id}`, {
			method: 'DELETE'
		});
		if (response.ok) {
			showNotification('删除成功', 'success');
			loadStreams();
		}
	} catch (error) {
		console.error('删除失败:', error);
		showNotification('删除失败', 'error');
	}
}

// ==================== 辩论设置 ====================
async function loadDebateSettings() {
	try {
		const response = await fetch(`${API_BASE}/debate`);
		const debate = await response.json();
		
		document.getElementById('debate-title').value = debate.title || '';
		document.getElementById('debate-description').value = debate.description || '';
		document.getElementById('left-position').value = debate.leftPosition || '';
		document.getElementById('right-position').value = debate.rightPosition || '';
	} catch (error) {
		console.error('加载辩论设置失败:', error);
	}
}

document.getElementById('save-debate-btn')?.addEventListener('click', async () => {
	const debateData = {
		title: document.getElementById('debate-title').value,
		description: document.getElementById('debate-description').value,
		leftPosition: document.getElementById('left-position').value,
		rightPosition: document.getElementById('right-position').value
	};
	
	try {
		const response = await fetch(`${API_BASE}/debate`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(debateData)
		});
		
		if (response.ok) {
			showNotification('保存成功', 'success');
			// 通过 WebSocket 通知更新（服务器端会自动广播，这里只是额外确认）
		} else {
			throw new Error('保存失败');
		}
	} catch (error) {
		console.error('保存失败:', error);
		showNotification('保存失败', 'error');
	}
});

// ==================== 直播控制 ====================
let currentLiveStatus = false;

// 加载当前直播状态
async function loadLiveStatus() {
	try {
		const result = await fetchDashboard();
		// 处理返回格式
		const data = result?.data || result;
		if (data && data.isLive !== undefined) {
			currentLiveStatus = data.isLive;
			// 右上角按钮仅由用户点击切换，不随 API 状态变化
		}
	} catch (error) {
		console.error('获取直播状态失败:', error);
	}
}

// 更新直播控制按钮
function updateLiveControlButton(isLive) {
	const btn = document.getElementById('control-live-btn');
	if (!btn) return;
	if (isLive) {
		btn.textContent = '关闭直播';
		btn.className = 'btn btn-sm btn-danger';
	} else {
		btn.textContent = '开始直播';
		btn.className = 'btn btn-sm btn-primary';
	}
}

// 控制直播状态 - 已移至admin-events.js中处理
// 使用admin-api.js中的startLive和stopLive函数
// 注意：直播控制按钮的事件监听器在 admin-events.js 的 initLiveControlEvents() 中绑定

// ==================== 直播设置整合页 ====================
async function loadLiveSetup() {
	try {
		// 1. 先加载直播流列表到选择框
		await loadStreamsToSelect();
		
		// 2. 加载当前直播状态
		const result = await fetchDashboard();
		// 处理返回格式
		const data = result?.data || result;
		if (data) {
			// 优先使用全局状态（如果存在且不一致，说明可能是刚操作后的状态）
			// 如果全局状态明确为 false，即使 dashboard 返回 true，也使用全局状态
			let isLive = data.isLive || false;
			
			// 检查是否刚刚停止直播，如果是，忽略 dashboard 返回的 true 状态
			const lastStopTime = window.lastStopLiveTime || 0;
			const timeSinceStop = Date.now() - lastStopTime;
			if (timeSinceStop < 5000) { // 5秒内，如果刚刚停止，强制使用 false
				if (window.globalState && window.globalState.isLive === false) {
					console.log('⚠️ 刚刚停止直播（' + Math.floor(timeSinceStop / 1000) + '秒前），强制使用 false 状态，忽略 dashboard 返回的 true');
					isLive = false;
				}
			} else if (window.globalState && window.globalState.isLive === false && data.isLive === true) {
				// 如果全局状态是 false，但 dashboard 返回 true，可能是后端还没更新
				// 延迟一下再检查，或者使用全局状态
				console.log('⚠️ 状态不一致：全局状态为 false，但 dashboard 返回 true，使用全局状态');
				isLive = false;
			}
			
			// 使用统一的UI更新函数，确保按钮状态正确
			if (typeof updateLiveStatusUI === 'function') {
				updateLiveStatusUI(isLive);
			}
			
			// 更新直播状态显示（使用修正后的 isLive 状态）
			const statusEl = document.getElementById('live-control-status');
			if (statusEl) {
				if (isLive) {
					statusEl.innerHTML = '<span style="color: #27ae60; display: flex; align-items: center; gap: 8px; justify-content: center;"><span class="iconfont icon-circle" style="font-size: 20px; color: #27ae60;"></span>直播中</span>';
					
					// 显示直播流信息
					if (data.liveStreamUrl) {
						const streamInfoEl = document.getElementById('live-stream-info');
						if (streamInfoEl) {
							streamInfoEl.style.display = 'block';
							const streamIdEl = document.getElementById('live-stream-id');
							const streamUrlEl = document.getElementById('live-stream-url');
							const startTimeEl = document.getElementById('live-start-time');
							if (streamIdEl) streamIdEl.textContent = data.liveId || '-';
							if (streamUrlEl) streamUrlEl.textContent = data.liveStreamUrl || '-';
							if (startTimeEl) startTimeEl.textContent = data.liveStartTime || '-';
						}
					}
				} else {
					statusEl.innerHTML = '<span style="color: #95a5a6; display: flex; align-items: center; gap: 8px; justify-content: center;"><span class="iconfont icon-circle" style="font-size: 20px; opacity: 0.5;"></span>未直播</span>';
					
					// 隐藏直播流信息
					const streamInfoEl = document.getElementById('live-stream-info');
					if (streamInfoEl) {
						streamInfoEl.style.display = 'none';
					}
				}
			}
		} else {
			// 如果没有数据，默认显示未直播状态
			if (typeof updateLiveStatusUI === 'function') {
				updateLiveStatusUI(false);
			}
		}
		
		// 3. 加载所有流的直播状态
		await loadAllStreamsStatus();
		
		// 4. 启动定时刷新流状态列表（每5秒刷新一次）
		if (window.streamsStatusRefreshTimer) {
			clearInterval(window.streamsStatusRefreshTimer);
		}
		window.streamsStatusRefreshTimer = setInterval(() => {
			// 只有在直播控制页面激活时才刷新
			if (document.getElementById('live-setup') && document.getElementById('live-setup').classList.contains('active')) {
				loadAllStreamsStatus();
			}
		}, 5000); // 每5秒刷新一次
		
		// 如果有其他旧的表单元素，尝试加载（但这些元素可能不存在）
		const streamSelect = document.getElementById('setup-stream-id');
		if (streamSelect) {
			try {
		const streamsResponse = await fetch(`${API_BASE}/streams`);
		const streams = await streamsResponse.json();
		streamSelect.innerHTML = '<option value="">请选择直播流</option>';
		
				if (Array.isArray(streams)) {
		streams.forEach(stream => {
			if (stream.enabled) {
				const option = document.createElement('option');
				option.value = stream.id;
				option.textContent = `${stream.name} (${stream.type.toUpperCase()})`;
				streamSelect.appendChild(option);
			}
		});
				}
			} catch (error) {
				console.warn('加载直播流列表失败:', error);
			}
		}
		
		// 加载辩论设置（如果元素存在）
		const debateTitleEl = document.getElementById('setup-debate-title');
		const debateDescEl = document.getElementById('setup-debate-description');
		const leftPosEl = document.getElementById('setup-left-position');
		const rightPosEl = document.getElementById('setup-right-position');
		
		if (debateTitleEl || debateDescEl || leftPosEl || rightPosEl) {
			try {
		const debateResponse = await fetch(`${API_BASE}/debate`);
		const debate = await debateResponse.json();
		
		if (debate) {
					if (debateTitleEl) debateTitleEl.value = debate.title || '';
					if (debateDescEl) debateDescEl.value = debate.description || '';
					if (leftPosEl) leftPosEl.value = debate.leftPosition || '';
					if (rightPosEl) rightPosEl.value = debate.rightPosition || '';
				}
			} catch (error) {
				console.warn('加载辩论设置失败:', error);
			}
		}
		
	} catch (error) {
		console.error('加载直播设置失败:', error);
		showNotification('加载失败', 'error');
	}
}

// 切换“创建直播流”表单显隐
document.getElementById('setup-toggle-create-stream')?.addEventListener('click', () => {
	const form = document.getElementById('setup-create-stream-form');
	if (form) {
		form.style.display = form.style.display === 'none' ? 'block' : 'none';
	}
});

// 保存直播流并刷新下拉
async function refreshSetupStreams(selectIdToChoose) {
	const streamSelect = document.getElementById('setup-stream-id');
	if (!streamSelect) return;
	const response = await fetch(`${API_BASE}/streams`);
	const streams = await response.json();
	streamSelect.innerHTML = '<option value="">请选择直播流</option>';
	streams.forEach(stream => {
		if (stream.enabled) {
			const option = document.createElement('option');
			option.value = stream.id;
			option.textContent = `${stream.name} (${stream.type.toUpperCase()})`;
			streamSelect.appendChild(option);
		}
	});
	if (selectIdToChoose) {
		streamSelect.value = selectIdToChoose;
	}
}

document.getElementById('setup-save-stream-btn')?.addEventListener('click', async () => {
	const name = document.getElementById('setup-new-stream-name')?.value?.trim();
	const url = document.getElementById('setup-new-stream-url')?.value?.trim();
	const type = document.getElementById('setup-new-stream-type')?.value || 'hls';
	const enabled = document.getElementById('setup-new-stream-enabled')?.checked ?? true;
	if (!name || !url) {
		showNotification('请填写完整的直播流信息（名称与地址）', 'error');
		return;
	}
	try {
		const resp = await fetch(`${API_BASE}/streams`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name, url, type, enabled })
		});
		if (!resp.ok) {
			throw new Error('创建直播流失败');
		}
		const created = await resp.json();
		const newId = created?.id || created?.data?.id || null;
		await refreshSetupStreams(newId);
		showNotification('直播流已创建并选用', 'success');
	} catch (e) {
		console.error('创建直播流失败:', e);
		showNotification('创建直播流失败', 'error');
	}
});

// 切换直播模式（立即开始/定时开始）
function updateLiveModeButtons() {
	const isNow = document.getElementById('live-mode-now')?.checked;
	const scheduleGroup = document.getElementById('schedule-time-group');
	const startNowBtn = document.getElementById('setup-start-now-btn');
	const scheduleBtn = document.getElementById('setup-schedule-btn');
	
	if (isNow) {
		scheduleGroup.style.display = 'none';
		if (startNowBtn) startNowBtn.style.display = 'flex';
		if (scheduleBtn) scheduleBtn.style.display = 'none';
	} else {
		scheduleGroup.style.display = 'block';
		if (startNowBtn) startNowBtn.style.display = 'none';
		if (scheduleBtn) scheduleBtn.style.display = 'flex';
	}
}

document.getElementById('live-mode-now')?.addEventListener('change', updateLiveModeButtons);
document.getElementById('live-mode-schedule')?.addEventListener('change', updateLiveModeButtons);

// 立即开始直播
document.getElementById('setup-start-now-btn')?.addEventListener('click', async () => {
	const streamId = document.getElementById('setup-stream-id').value;
	const debateTitle = document.getElementById('setup-debate-title').value;
	const debateDescription = document.getElementById('setup-debate-description').value;
	const leftPosition = document.getElementById('setup-left-position').value;
	const rightPosition = document.getElementById('setup-right-position').value;
	
	// 验证必填字段
	if (!streamId) {
		showNotification('请选择直播流', 'error');
		return;
	}
	if (!debateTitle || !leftPosition || !rightPosition) {
		showNotification('请填写完整的辩论设置（辩题标题、正方立场、反方立场）', 'error');
		return;
	}
	
	if (!confirm('确定要立即开始直播吗？这将设置当前直播流和辩论，并立即开始直播。')) {
		return;
	}
	
	try {
		// 先设置辩论
		await fetch(`${API_BASE}/debate`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				title: debateTitle,
				description: debateDescription,
				leftPosition: leftPosition,
				rightPosition: rightPosition
			})
		});
		
		// 然后开始直播
		const response = await fetch(`${API_BASE}/live/setup-and-start`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				streamId: streamId,
				startNow: true
			})
		});
		
		const result = await response.json();
		if (result.success) {
			showNotification('直播已开始！', 'success');
			loadLiveStatus();
		} else {
			throw new Error(result.error || '开始直播失败');
		}
	} catch (error) {
		console.error('开始直播失败:', error);
		showNotification('开始直播失败: ' + error.message, 'error');
	}
});

// 保存并设置定时开始（或保存设置，取决于选择的模式）
document.getElementById('setup-schedule-btn')?.addEventListener('click', async () => {
	const streamId = document.getElementById('setup-stream-id').value;
	const debateTitle = document.getElementById('setup-debate-title').value;
	const debateDescription = document.getElementById('setup-debate-description').value;
	const leftPosition = document.getElementById('setup-left-position').value;
	const rightPosition = document.getElementById('setup-right-position').value;
	const isSchedule = document.getElementById('live-mode-schedule').checked;
	
	// 验证必填字段
	if (!streamId) {
		showNotification('请选择直播流', 'error');
		return;
	}
	if (!debateTitle || !leftPosition || !rightPosition) {
		showNotification('请填写完整的辩论设置（辩题标题、正方立场、反方立场）', 'error');
		return;
	}
	
	let scheduledStartTime = null;
	let scheduledEndTime = null;
	
	if (isSchedule) {
		const startTime = document.getElementById('setup-start-time').value;
		if (!startTime) {
			showNotification('请设置直播开始时间', 'error');
			return;
		}
		scheduledStartTime = new Date(startTime).toISOString();
		const endTime = document.getElementById('setup-end-time').value;
		if (endTime) {
			scheduledEndTime = new Date(endTime).toISOString();
		}
	}
	
	try {
		// 设置辩论
		const debateResponse = await fetch(`${API_BASE}/debate`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				title: debateTitle,
				description: debateDescription,
				leftPosition: leftPosition,
				rightPosition: rightPosition
			})
		});
		
		if (!debateResponse.ok) {
			throw new Error('保存辩论设置失败');
		}
		
		// 设置直播计划
		const response = await fetch(`${API_BASE}/live/setup-and-start`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				streamId: streamId,
				scheduledStartTime: scheduledStartTime,
				scheduledEndTime: scheduledEndTime,
				startNow: false
			})
		});
		
		const result = await response.json();
		if (result.success) {
			if (isSchedule) {
				showNotification('直播计划已设置！', 'success');
			} else {
				showNotification('设置已保存！', 'success');
			}
			loadLiveStatus();
		} else {
			throw new Error(result.error || '设置失败');
		}
	} catch (error) {
		console.error('设置失败:', error);
		showNotification('设置失败: ' + error.message, 'error');
	}
});

// 加载直播流列表到选择框
async function loadStreamsToSelect() {
	try {
		const streamSelect = document.getElementById('stream-select');
		if (!streamSelect) return;
		
		// 先显示加载中
		streamSelect.innerHTML = '<option value="">加载中...</option>';
		
		const result = await getStreamsList();
		
		// 处理返回数据，可能是数组或者包含data字段的对象
		let streams = [];
		if (Array.isArray(result)) {
			streams = result;
		} else if (result && Array.isArray(result.data)) {
			streams = result.data;
		} else if (result && typeof result === 'object') {
			streams = result.streams || result.items || result.list || [];
		}
		
		// 清空选择框
		streamSelect.innerHTML = '<option value="">使用默认启用的直播流</option>';
		
		if (streams.length === 0) {
			streamSelect.innerHTML += '<option value="" disabled>暂无可用的直播流</option>';
			return;
		}
		
		// 填充直播流选项
		streams.forEach(stream => {
			const option = document.createElement('option');
			option.value = stream.id;
			option.textContent = `${stream.name} (${stream.type?.toUpperCase() || 'HLS'})${stream.enabled ? ' [已启用]' : ''}`;
			streamSelect.appendChild(option);
		});
		
		// 如果有启用的流，默认选中第一个启用的流
		const activeStream = streams.find(s => s.enabled === true);
		if (activeStream && streamSelect) {
			streamSelect.value = activeStream.id;
			updateSelectedStreamInfo(activeStream);
			// 🔧 修复：默认选择流后，重新加载该流的 Dashboard 数据
			console.log(`🔄 默认选择流 ${activeStream.id}，重新加载 Dashboard...`);
			loadDashboard();
		}
		
		// 移除旧的监听器，避免重复绑定
		const oldStreamSelect = document.getElementById('stream-select');
		if (oldStreamSelect && oldStreamSelect === streamSelect) {
			// 克隆节点并替换，这样可以移除所有旧的事件监听器
			const newStreamSelect = oldStreamSelect.cloneNode(true);
			
			// 如果有启用的流，确保新选择框也选中
			if (activeStream) {
				newStreamSelect.value = activeStream.id;
			}
			
			oldStreamSelect.parentNode.replaceChild(newStreamSelect, oldStreamSelect);
			
			// 🔧 修复：如果新节点有选中的流，重新加载该流的 Dashboard
			if (activeStream && newStreamSelect.value === activeStream.id) {
				console.log(`🔄 替换节点后，重新加载流 ${activeStream.id} 的 Dashboard...`);
				loadDashboard();
			}
			
			// 监听选择变化
			newStreamSelect.addEventListener('change', async (e) => {
				const selectedId = e.target.value;
				if (selectedId) {
					const selectedStream = streams.find(s => s.id === selectedId);
					if (selectedStream) {
						updateSelectedStreamInfo(selectedStream);
						// 🔧 修复：选择流后重新加载 Dashboard，显示该流的票数
						console.log(`🔄 切换到流 ${selectedId}，重新加载 Dashboard...`);
						await loadDashboard();
					} else {
						hideSelectedStreamInfo();
					}
				} else {
					hideSelectedStreamInfo();
					// 🔧 修复：取消选择后重新加载默认 Dashboard
					console.log('🔄 取消选择流，重新加载默认 Dashboard...');
					await loadDashboard();
				}
			});
		}
		
		// 保存 streams 到全局变量，方便后续使用
		window.liveSetupStreams = streams;
		
		console.log('✅ 直播流列表已加载到选择框');
	} catch (error) {
		console.error('❌ 加载直播流列表失败:', error);
		const streamSelect = document.getElementById('stream-select');
		if (streamSelect) {
			streamSelect.innerHTML = '<option value="">加载失败，请刷新重试</option>';
		}
	}
}

// 更新选中的直播流信息显示
function updateSelectedStreamInfo(stream) {
	const infoEl = document.getElementById('selected-stream-info');
	const nameEl = document.getElementById('selected-stream-name');
	const urlEl = document.getElementById('selected-stream-url');
	const typeEl = document.getElementById('selected-stream-type');
	
	if (infoEl) infoEl.style.display = 'block';
	if (nameEl) nameEl.textContent = stream.name || '-';
	if (urlEl) urlEl.textContent = stream.url || '-';
	if (typeEl) typeEl.textContent = (stream.type?.toUpperCase() || 'HLS');
}

// 隐藏选中的直播流信息
function hideSelectedStreamInfo() {
	const infoEl = document.getElementById('selected-stream-info');
	if (infoEl) infoEl.style.display = 'none';
}

// 加载所有流的直播状态
async function loadAllStreamsStatus() {
	try {
		const response = await fetch(`${API_BASE}/streams`);
		const result = await response.json();

		// 处理响应格式
		let streams = [];
		if (result.success && result.data) {
			if (result.data.streams) {
				streams = result.data.streams;
			} else if (Array.isArray(result.data)) {
				streams = result.data;
			}
		} else if (Array.isArray(result)) {
			streams = result;
		}

		const container = document.getElementById('all-streams-status');
		if (!container) return;

		if (streams.length === 0) {
			container.innerHTML = '<div style="text-align: center; padding: 20px; color: #999;">暂无直播流</div>';
			return;
		}

		// 找出当前正在直播的流
		const liveStream = streams.find(s => s.liveStatus && s.liveStatus.isLive);

		// 生成状态列表HTML - 增强版本，支持流的独立状态管理
		container.innerHTML = streams.map(stream => {
			const status = stream.liveStatus || {};
			const isLive = status.isLive || false;
			const startTime = status.startTime ? new Date(status.startTime).toLocaleString('zh-CN') : '-';
			const duration = status.startTime ? calculateDuration(status.startTime) : '-';

			// 状态徽章样式
			const statusBadgeColor = isLive ? '#27ae60' : '#95a5a6';
			const statusBadgeText = isLive ? '<span class="iconfont icon-circle" style="font-size: 12px; color: #27ae60; margin-right: 4px;"></span>正在直播' : '<span class="iconfont icon-circle" style="font-size: 12px; opacity: 0.5; margin-right: 4px;"></span>未直播';
			const statusBgColor = isLive ? '#f0f9ff' : '#fafafa';
			const statusBorderColor = isLive ? '#e3f2fd' : '#e0e0e0';

			// 流启用状态指示器
			const enabledIndicator = stream.enabled 
				? '<span class="iconfont icon-check" style="color: #27ae60; font-size: 14px;"></span>' 
				: '<span class="iconfont icon-close" style="color: #e74c3c; font-size: 14px;"></span>';
			const enabledText = stream.enabled ? '已启用' : '已禁用';

			// 当前选中的流显示特殊样式
			const isSelected = document.getElementById('stream-select')?.value === stream.id;
			const selectedStyle = isSelected ? 'border: 2px solid #667eea; box-shadow: 0 2px 12px rgba(102, 126, 234, 0.15);' : '';

			return `
				<div style="border: 1px solid ${statusBorderColor}; border-radius: 8px; padding: 18px; background: ${statusBgColor}; ${selectedStyle} transition: all 0.3s ease;">
					<div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 15px;">
						<!-- 左侧流信息 -->
						<div style="flex: 1; min-width: 0;">
							<!-- 流名称与启用状态 -->
							<div style="display: flex; align-items: center; gap: 10px; margin-bottom: 10px;">
								<span style="font-size: 16px;">${enabledIndicator}</span>
								<span style="font-weight: bold; color: #333; font-size: 15px;">${stream.name || '未命名'}</span>
								<span style="font-size: 12px; color: #999; background: #f5f5f5; padding: 2px 8px; border-radius: 4px;">${enabledText}</span>
								<span style="font-size: 12px; color: #999; background: #f5f5f5; padding: 2px 8px; border-radius: 4px;">ID: ${stream.id.substring(0, 8)}</span>
							</div>

							<!-- 流配置信息 -->
							<div style="font-size: 12px; color: #666; margin-bottom: 8px; line-height: 1.6;">
								<div><strong>类型:</strong> ${(stream.type || 'HLS').toUpperCase()}</div>
								<div style="word-break: break-all;"><strong>地址:</strong> ${stream.url ? (stream.url.length > 60 ? stream.url.substring(0, 60) + '...' : stream.url) : '-'}</div>
							</div>

							<!-- 直播状态 -->
							<div style="display: flex; align-items: center; gap: 15px; font-size: 13px;">
								<div>
									<strong>状态:</strong>
									<span style="color: ${statusBadgeColor}; font-weight: bold; margin-left: 4px;">
										${statusBadgeText}
									</span>
								</div>
								${isLive ? `
									<div style="color: #666;">
										<strong>开始:</strong> <span style="color: #999;">${startTime}</span>
									</div>
									<div style="color: #666;">
										<strong>时长:</strong> <span style="color: #999;">${duration}</span>
									</div>
								` : ''}
							</div>
						</div>

						<!-- 右侧操作按钮 -->
						<div style="display: flex; gap: 10px; flex-direction: column; min-width: max-content;">
							${stream.enabled ? `
								<button
									class="btn ${isLive ? 'btn-danger' : 'btn-success'}"
									style="padding: 10px 18px; font-size: 14px; font-weight: 600; white-space: nowrap; min-width: 100px; transition: all 0.3s ease;"
									onclick="controlStreamLive('${stream.id}', ${!isLive})"
								>
									${isLive ? '<span class="iconfont icon-stop" style="font-size: 14px; margin-right: 4px;"></span>关闭' : '<img src="/static/iconfont/bofang.png" style="width: 14px; height: 14px; filter: brightness(0) invert(1); margin-right: 4px; vertical-align: middle;" alt="">开始'}
								</button>
								${isLive ? `
									<div style="font-size: 11px; color: #27ae60; text-align: center; background: #d4edda; padding: 6px 10px; border-radius: 4px; border-left: 3px solid #27ae60; display: flex; align-items: center; justify-content: center; gap: 4px;">
										<span class="iconfont icon-circle" style="font-size: 10px; color: #27ae60;"></span>直播进行中
									</div>
								` : ''}
							` : `
								<button
									class="btn btn-secondary"
									style="padding: 10px 18px; font-size: 14px; font-weight: 600; white-space: nowrap; min-width: 100px; display: flex; align-items: center; justify-content: center; gap: 4px;"
									disabled
									title="请先启用此流"
								>
									<span class="iconfont icon-close" style="font-size: 14px; color: #6c757d;"></span>已禁用
								</button>
							`}
						</div>
					</div>
				</div>
			`;
		}).join('');

		console.log('✅ 所有流状态已加载');
	} catch (error) {
		console.error('❌ 加载所有流状态失败:', error);
		const container = document.getElementById('all-streams-status');
		if (container) {
			container.innerHTML = '<div style="text-align: center; padding: 20px; color: #f44336;">加载失败: ' + error.message + '</div>';
		}
	}
}

// 计算直播时长（格式化显示）
function calculateDuration(startTime) {
	const start = new Date(startTime);
	const now = new Date();
	const diff = Math.floor((now - start) / 1000); // 秒
	
	const hours = Math.floor(diff / 3600);
	const minutes = Math.floor((diff % 3600) / 60);
	const seconds = diff % 60;
	
	if (hours > 0) {
		return `${hours}时${minutes}分${seconds}秒`;
	} else if (minutes > 0) {
		return `${minutes}分${seconds}秒`;
	} else {
		return `${seconds}秒`;
	}
}

// 控制单个流的直播状态 - 支持多直播流的独立管理
async function controlStreamLive(streamId, start) {
	const streamName = window.liveSetupStreams?.find(s => s.id === streamId)?.name || streamId;
	let autoStartAI = false;
	if (start) {
		// 确定=启动AI，取消=不启动AI
		autoStartAI = confirm('所有直播流一起开启，是否启动AI识别内容');
	}
		if (!confirm(start ?
		`确定要开始直播流 "${streamName}" 吗？\n\n提示：可以同时开启多个直播流。\n${autoStartAI ? '（将启动AI识别）' : '（不启动AI）'}` :
		`确定要停止直播流 "${streamName}" 吗？`
	)) {
		return;
	}

	try {
		// 直接使用admin-api.js中的函数（已在页面中加载）
		if (typeof startLive === 'undefined' || typeof stopLive === 'undefined') {
			console.error('❌ startLive 或 stopLive 函数未定义，请确保 admin-api.js 已加载');
			alert('系统错误：API函数未加载');
			return;
		}

		if (start) {
			// 开始直播某个流（autoStartAI 已由上方 confirm 决定）
			console.log(`🚀 正在启动直播流: ${streamId}`);
			// 调用 API 开始直播（支持多流并发）
			const result = await startLive(streamId, autoStartAI, true);

			if (result && (result.success || result.streamUrl || result.status === 'started' || result.data?.status === 'started')) {
				console.log('✅ 开始直播成功:', result);
				showNotification(`✅ 直播流 "${streamName}" 已开始！`, 'success');
				// 立即刷新多直播总览
				if (typeof renderMultiLiveOverview === 'function') {
					setTimeout(() => renderMultiLiveOverview(), 300);
				}

				// 立即刷新状态列表（不等待WebSocket）
				setTimeout(() => {
					console.log('🔄 刷新流状态列表...');
					if (typeof loadAllStreamsStatus === 'function') {
						loadAllStreamsStatus();
					}
					if (typeof loadLiveSetup === 'function') {
						loadLiveSetup();
					}
				}, 300);

				// 延迟再次刷新，确保后端状态已完全更新
				setTimeout(() => {
					console.log('🔄 再次刷新流状态列表...');
					if (typeof renderMultiLiveOverview === 'function') {
						renderMultiLiveOverview();
					}
					if (typeof loadAllStreamsStatus === 'function') {
						loadAllStreamsStatus();
					}
					if (typeof loadLiveSetup === 'function') {
						loadLiveSetup();
					}
				}, 1500);
			} else {
				console.error('❌ 开始直播失败:', result);
				const errorMsg = result?.message || result?.error || '未知错误';
				showNotification('❌ 开始直播失败: ' + errorMsg, 'error');
			}
		} else {
			// 停止直播某个流
			console.log(`⏹️ 正在停止直播流: ${streamId}`);

			const result = await stopLive(streamId, true, true);

			if (result && (result.success || result.status === 'stopped' || result.data?.status === 'stopped' || (!result.error && !result.message))) {
				console.log('✅ 停止直播成功:', result);
				showNotification(`✅ 直播流 "${streamName}" 已停止！`, 'success');
				// 立即刷新多直播总览
				if (typeof renderMultiLiveOverview === 'function') {
					setTimeout(() => renderMultiLiveOverview(), 300);
				}

				// 立即刷新状态列表（不等待WebSocket）
				setTimeout(() => {
					console.log('🔄 刷新流状态列表...');
					if (typeof loadAllStreamsStatus === 'function') {
						loadAllStreamsStatus();
					}
					if (typeof loadLiveSetup === 'function') {
						loadLiveSetup();
					}
				}, 300);

				// 延迟再次刷新，确保后端状态已完全更新
				setTimeout(() => {
					console.log('🔄 再次刷新流状态列表...');
					if (typeof renderMultiLiveOverview === 'function') {
						renderMultiLiveOverview();
					}
					if (typeof loadAllStreamsStatus === 'function') {
						loadAllStreamsStatus();
					}
					if (typeof loadLiveSetup === 'function') {
						loadLiveSetup();
					}
				}, 1500);

				// 清理AI内容刷新定时器（如果停止直播）
				if (window.aiContentRefreshTimer) {
					clearInterval(window.aiContentRefreshTimer);
					window.aiContentRefreshTimer = null;
					console.log('🧹 已清理AI内容刷新定时器');
				}
			} else {
				console.error('❌ 停止直播失败:', result);
				const errorMsg = result?.message || result?.error || '未知错误';
				showNotification('❌ 停止直播失败: ' + errorMsg, 'error');
			}
		}
	} catch (error) {
		console.error('❌ 控制直播失败:', error);
		showNotification('❌ 操作失败: ' + error.message, 'error');
	}
}

// 将函数挂载到全局，供HTML onclick调用
window.controlStreamLive = controlStreamLive;

// ==================== 直播计划管理 ====================
let scheduleUpdateTimer = null;

async function loadLiveSchedule() {
	try {
		// 加载直播流列表
		const streamsResponse = await fetch(`${API_BASE}/streams`);
		const streams = await streamsResponse.json();
		
		const streamSelect = document.getElementById('schedule-stream-id');
		streamSelect.innerHTML = '<option value="">使用默认启用的直播流</option>';
		
		streams.forEach(stream => {
			if (stream.enabled) {
				const option = document.createElement('option');
				option.value = stream.id;
				option.textContent = `${stream.name} (${stream.type.toUpperCase()})`;
				streamSelect.appendChild(option);
			}
		});
		
		// 加载当前计划
		const scheduleResponse = await fetch(`${API_BASE}/live/schedule`);
		const scheduleResult = await scheduleResponse.json();
		
		if (scheduleResult.success && scheduleResult.data.isScheduled) {
			const schedule = scheduleResult.data;
			displayScheduleInfo(schedule);
			
			// 设置表单值
			if (schedule.streamId) {
				streamSelect.value = schedule.streamId;
			}
			if (schedule.scheduledStartTime) {
				const startDate = new Date(schedule.scheduledStartTime);
				document.getElementById('schedule-start-time').value = formatDateTimeLocal(startDate);
			}
			if (schedule.scheduledEndTime) {
				const endDate = new Date(schedule.scheduledEndTime);
				document.getElementById('schedule-end-time').value = formatDateTimeLocal(endDate);
			}
			
			document.getElementById('cancel-schedule-btn').style.display = 'inline-block';
			
			// 启动定时更新倒计时（每10秒更新一次）
			if (scheduleUpdateTimer) {
				clearInterval(scheduleUpdateTimer);
			}
			scheduleUpdateTimer = setInterval(async () => {
				try {
					const scheduleResponse = await fetch(`${API_BASE}/live/schedule`);
					const scheduleResult = await scheduleResponse.json();
					if (scheduleResult.success && scheduleResult.data.isScheduled) {
						displayScheduleInfo(scheduleResult.data);
					}
				} catch (error) {
					console.error('更新计划信息失败:', error);
				}
			}, 10000); // 每10秒更新一次倒计时
		} else {
			clearScheduleInfo();
			document.getElementById('cancel-schedule-btn').style.display = 'none';
			if (scheduleUpdateTimer) {
				clearInterval(scheduleUpdateTimer);
				scheduleUpdateTimer = null;
			}
		}
	} catch (error) {
		console.error('加载直播计划失败:', error);
		showNotification('加载失败', 'error');
	}
}

function formatDateTimeLocal(date) {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	const hours = String(date.getHours()).padStart(2, '0');
	const minutes = String(date.getMinutes()).padStart(2, '0');
	return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function displayScheduleInfo(schedule) {
	const statusDisplay = document.getElementById('schedule-status-display');
	const startTime = new Date(schedule.scheduledStartTime);
	const endTime = schedule.scheduledEndTime ? new Date(schedule.scheduledEndTime) : null;
	const now = new Date();
	const timeUntilStart = startTime - now;
	
	let statusHtml = '';
	if (timeUntilStart > 0) {
		const hours = Math.floor(timeUntilStart / (1000 * 60 * 60));
		const minutes = Math.floor((timeUntilStart % (1000 * 60 * 60)) / (1000 * 60));
			statusHtml = `
			<p style="color: #27ae60; font-weight: bold; display: flex; align-items: center; gap: 6px;"><span class="iconfont icon-check" style="font-size: 16px;"></span>计划已设置</p>
			<p><strong>开始时间:</strong> ${startTime.toLocaleString('zh-CN')}</p>
			${endTime ? `<p><strong>结束时间:</strong> ${endTime.toLocaleString('zh-CN')}</p>` : '<p><strong>结束时间:</strong> 手动停止</p>'}
			<p><strong>距离开始:</strong> ${hours}小时 ${minutes}分钟</p>
		`;
	} else {
		statusHtml = `
			<p style="color: #f39c12; font-weight: bold; display: flex; align-items: center; gap: 6px;"><span class="iconfont icon-warning" style="font-size: 16px;"></span>计划时间已过</p>
			<p><strong>开始时间:</strong> ${startTime.toLocaleString('zh-CN')}</p>
		`;
	}
	
	statusDisplay.innerHTML = statusHtml;
}

function clearScheduleInfo() {
	const statusDisplay = document.getElementById('schedule-status-display');
	statusDisplay.innerHTML = '<p style="color: #999;">暂无计划</p>';
}

// 保存直播计划
document.getElementById('save-schedule-btn')?.addEventListener('click', async () => {
	const startTimeInput = document.getElementById('schedule-start-time');
	const endTimeInput = document.getElementById('schedule-end-time');
	const streamIdSelect = document.getElementById('schedule-stream-id');
	
	const startTime = startTimeInput.value;
	if (!startTime) {
		showNotification('请设置直播开始时间', 'error');
		return;
	}
	
	const scheduleData = {
		scheduledStartTime: new Date(startTime).toISOString(),
		scheduledEndTime: endTimeInput.value ? new Date(endTimeInput.value).toISOString() : null,
		streamId: streamIdSelect.value || null
	};
	
	try {
		const response = await fetch(`${API_BASE}/live/schedule`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(scheduleData)
		});
		
		const result = await response.json();
		if (result.success) {
			showNotification('直播计划已设置', 'success');
			loadLiveSchedule();
			loadLiveStatus();
		} else {
			throw new Error(result.error || '设置失败');
		}
	} catch (error) {
		console.error('设置直播计划失败:', error);
		showNotification('设置失败: ' + error.message, 'error');
	}
});

// 取消直播计划
document.getElementById('cancel-schedule-btn')?.addEventListener('click', async () => {
	if (!confirm('确定要取消当前的直播计划吗？')) {
		return;
	}
	
	try {
		const response = await fetch(`${API_BASE}/live/schedule/cancel`, {
			method: 'POST'
		});
		
		const result = await response.json();
		if (result.success) {
			showNotification('直播计划已取消', 'success');
			loadLiveSchedule();
			loadLiveStatus();
		} else {
			throw new Error(result.error || '取消失败');
		}
	} catch (error) {
		console.error('取消直播计划失败:', error);
		showNotification('取消失败', 'error');
	}
});

// 初始化时加载直播状态
loadLiveStatus();

// ==================== 用户管理 ====================
async function loadUsers() {
	try {
		const data = await fetchUserList(1, 50, {});
		if (!data || !data.users) {
			console.error('获取用户列表失败');
			return;
		}
		
		const tbody = document.getElementById('users-table-body');
		tbody.innerHTML = '';
		
		if (data.users.length === 0) {
			tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 40px; color: #999;">暂无用户，点击「开始直播」后将自动注入 35 个模拟观众</td></tr>';
			return;
		}
		
		const placeholderSvg = 'data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'40\' height=\'40\'%3E%3Crect width=\'40\' height=\'40\' fill=\'%23e0e0e0\'/%3E%3Ctext x=\'50%25\' y=\'50%25\' text-anchor=\'middle\' dy=\'.3em\' fill=\'%23999\' font-size=\'14\'%3E头像%3C/text%3E%3C/svg%3E';
		// 数据概览 Mock：平台显示几人在线，用户列表就显示几人在线（前 N 个为在线）
		const platformOnline = (typeof mockGetGlobalDisplayData === 'function' && mockGetGlobalDisplayData())?.activeUsers;
		const usePlatformOnlineCount = typeof platformOnline === 'number' && platformOnline >= 0;
		
		data.users.forEach((user, index) => {
			const row = document.createElement('tr');
			// 兼容本地 mock 用户字段：id/nickName/avatarUrl/createdAt 与 userId/nickname/avatar/joinTime
			const userId = user.userId || user.id || '';
			const nickname = user.nickname || user.nickName || '未设置';
			const avatarUrl = user.avatar || user.avatarUrl || '';
			const joinTime = user.joinTime || user.createdAt || '';
			const status = user.status || 'active';
			
			let avatarSrc = placeholderSvg;
			if (avatarUrl && !avatarUrl.includes('logo.png') && !avatarUrl.includes('thirdwx.qlogo.cn')) {
				// 支持 http 或相对路径（如 /static/iconfont/wode.png）
				if (avatarUrl.startsWith('http') || avatarUrl.startsWith('/')) {
					avatarSrc = avatarUrl.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
				}
			}
			
			const safeUserId = String(userId).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
			const displayUserId = userId ? (userId.length > 12 ? userId.slice(0, 12) + '...' : userId) : 'N/A';
			const isBanned = status === 'banned';
			const isOnline = usePlatformOnlineCount ? (index < platformOnline && !isBanned) : (status === 'online' || status === 'active');
			const voteTimes = user.voteTimes || 0;
			
			row.innerHTML = `
				<td>${displayUserId}</td>
				<td>${(nickname || '未设置').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</td>
				<td><img src="${avatarSrc}" class="avatar-img" onerror="this.src='${placeholderSvg}'; this.onerror=null;"></td>
				<td>${joinTime ? new Date(joinTime).toLocaleString() : '-'}</td>
				<td>
					<button class="btn btn-sm btn-info" style="padding: 4px 10px;" onclick='openUserVoteHistoryModal("${safeUserId}")'>
						${voteTimes}
					</button>
				</td>
				<td><span class="badge ${isBanned ? 'danger' : (isOnline ? 'success' : 'secondary')}">${isBanned ? '已禁用' : (isOnline ? '在线' : '离线')}</span></td>
				<td>
					<button class="btn btn-sm ${isBanned ? 'btn-danger' : 'btn-secondary'}" onclick='toggleUserBan("${safeUserId}")'>
						${isBanned ? '已禁用' : '禁用'}
					</button>
				</td>
			`;
			tbody.appendChild(row);
		});
	} catch (error) {
		console.error('加载用户失败:', error);
		showNotification('加载失败', 'error');
	}
}

// 搜索用户
document.getElementById('user-search')?.addEventListener('input', (e) => {
	// 实现搜索逻辑
	const searchTerm = e.target.value.toLowerCase();
	const rows = document.querySelectorAll('#users-table-body tr');
	rows.forEach(row => {
		const text = row.textContent.toLowerCase();
		row.style.display = text.includes(searchTerm) ? '' : 'none';
	});
});

function viewUser(id) {
	// 实现用户详情查看
	alert(`查看用户 ${id} 的详细信息`);
}

// 禁用/解禁用户（拉黑）
async function toggleUserBan(userId) {
	try {
		const resp = await fetch(`/api/v1/admin/users/${encodeURIComponent(userId)}/toggle-ban`, { method: 'POST' });
		const data = await resp.json();
		if (!data || data.success === false) throw new Error(data?.message || '操作失败');
		await loadUsers();
	} catch (e) {
		console.error('禁用用户失败:', e);
		alert('操作失败：' + e.message);
	}
}
window.toggleUserBan = toggleUserBan;

// 打开投票详情弹窗
async function openUserVoteHistoryModal(userId) {
	const modal = document.getElementById('user-votes-modal');
	const listEl = document.getElementById('user-votes-list');
	if (!modal || !listEl) return;
	listEl.innerHTML = '<div style="text-align:center;padding:30px;color:#999;">加载中...</div>';
	modal.classList.add('show');
	try {
		const resp = await fetch(`/api/v1/admin/users/${encodeURIComponent(userId)}/votes`);
		const json = await resp.json();
		const items = json?.data?.items || [];
		if (!items.length) {
			listEl.innerHTML = '<div style="text-align:center;padding:30px;color:#999;">暂无投票记录</div>';
			return;
		}
		listEl.innerHTML = items.map(it => {
			const at = it.at ? new Date(it.at).toLocaleString('zh-CN') : '-';
			const sideText = it.side === 'left' ? '正方' : '反方';
			const votes = it.votes ?? 0;
			const streamId = it.streamId || '-';
			// 1次投票行为 = 2票（普通用户）或 10票（评委），全部投给同一阵营
			const actionDesc = votes === 2
				? `1次投票行为，2票投给${sideText}`
				: `1次投票行为，${votes}票投给${sideText}`;
			return `
				<div style="padding: 12px 10px; border-bottom: 1px solid #eee;">
					<div style="display:flex;justify-content:space-between;gap:10px;align-items:center;">
						<div style="font-weight:600;color:#333;">${actionDesc}</div>
						<div style="font-size:12px;color:#999;">${at}</div>
					</div>
					<div style="margin-top:6px;font-size:12px;color:#666;">流ID: ${streamId}</div>
				</div>
			`;
		}).join('');
	} catch (e) {
		console.error('加载投票详情失败:', e);
		listEl.innerHTML = '<div style="text-align:center;padding:30px;color:#f44336;">加载失败：' + e.message + '</div>';
	}
}
window.openUserVoteHistoryModal = openUserVoteHistoryModal;

// ==================== 票数管理 ====================
async function loadVotes() {
	try {
		const votesStreamSelect = document.getElementById('votes-stream-select');
		const selectedStreamId = votesStreamSelect?.value;
		if (!selectedStreamId) return;
		
		const data = await fetchDashboardByStream(selectedStreamId);
		if (!data) return;
		
		const leftVotes = data.leftVotes || 0;
		const rightVotes = data.rightVotes || 0;
		const totalVotes = data.totalVotes || (leftVotes + rightVotes);
		const leftPercentage = data.leftPercentage || (totalVotes > 0 ? Math.round((leftVotes / totalVotes) * 100) : 50);
		const rightPercentage = data.rightPercentage || (totalVotes > 0 ? Math.round((rightVotes / totalVotes) * 100) : 50);
		
		// 更新票数页大数字与百分比（与 admin-events 中 updateVotesDisplay 一致）
		if (typeof updateVotesDisplay === 'function') {
			updateVotesDisplay({ leftVotes, rightVotes, totalVotes, leftPercentage, rightPercentage });
		} else {
			const leftEl = document.getElementById('admin-left-votes');
			const rightEl = document.getElementById('admin-right-votes');
			const totalEl = document.getElementById('admin-total-votes');
			const pctEl = document.getElementById('admin-vote-percentage');
			if (leftEl) leftEl.textContent = leftVotes;
			if (rightEl) rightEl.textContent = rightVotes;
			if (totalEl) totalEl.textContent = totalVotes;
			if (pctEl) pctEl.textContent = `正方: ${leftPercentage}% | 反方: ${rightPercentage}%`;
		}
		globalState.currentVotes = { leftVotes, rightVotes };
	} catch (error) {
		console.error('加载票数失败:', error);
		showNotification('加载票数失败', 'error');
	}
}

// 票数实时刷新控制
let votesTimer = null;
function startVotesAutoRefresh() {
    if (votesTimer) clearInterval(votesTimer);
    if (!currentLiveStatus) return;
    loadVotes();
    votesTimer = setInterval(() => {
        if (!currentLiveStatus) return;
        loadVotes();
    }, 10000);
}
function stopVotesAutoRefresh() {
    if (votesTimer) clearInterval(votesTimer);
    votesTimer = null;
}

// 票数管理相关函数已移至admin-events.js中处理

// ==================== AI 内容管理 ====================
async function loadAIContent() {
	try {
		const data = await fetchAIContentList(1, 20);
		if (!data || !data.items) {
			console.error('获取AI内容列表失败');
			return;
		}
		
		const container = document.getElementById('ai-content-list');
		if (!container) return;
		
		if (data.items.length === 0) {
			container.innerHTML = '<div style="text-align: center; padding: 40px; color: #999;">暂无AI内容</div>';
			return;
		}
		
		// 使用与loadAIContentList相同的样式渲染
		container.innerHTML = data.items.map(item => {
			// 转义HTML特殊字符以防止XSS
			const safeContent = (item.content || item.text || '').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
			const safeId = (item.id || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
			const timestamp = item.timestamp || '';
			
			return `
				<div class="ai-content-item" style="padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px; margin-bottom: 15px; background: white;">
					<div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 10px;">
						<div style="flex: 1;">
							<span style="display: inline-flex; align-items: center; gap: 4px; padding: 4px 12px; border-radius: 12px; font-size: 12px; background: ${item.position === 'left' ? '#e8f5e9' : '#e3f2fd'}; color: ${item.position === 'left' ? '#27ae60' : '#2196F3'}; margin-right: 10px;">
								<img src="/static/iconfont/fangyudunpai-.png" style="width: 14px; height: 14px; opacity: 0.8;" alt="">
								${item.position === 'left' ? '正方' : '反方'}
							</span>
							<span style="color: #999; font-size: 12px;">${timestamp}</span>
							<span style="color: #999; font-size: 12px; margin-left: 10px;">置信度: ${((item.confidence || 0) * 100).toFixed(0)}%</span>
						</div>
						<button class="btn btn-danger btn-sm" onclick="deleteAIContentItem('${safeId}')" style="padding: 4px 12px;">删除</button>
					</div>
					<div style="color: #333; line-height: 1.6; margin-bottom: 10px;">${safeContent}</div>
					<div style="display: flex; gap: 15px; color: #999; font-size: 12px; margin-bottom: 10px; align-items: center;">
						<span style="display: flex; align-items: center; gap: 4px;"><img src="/static/iconfont/guankanrenshu.png" style="width: 14px; height: 14px; opacity: 0.7;" alt="">${(item.statistics && item.statistics.views) || 0} 查看</span>
						<span style="display: flex; align-items: center; gap: 4px;"><img src="/static/iconfont/dianzan.png" style="width: 14px; height: 14px; opacity: 0.7;" alt="">${(item.statistics && item.statistics.likes) || 0} 点赞</span>
						<span style="display: flex; align-items: center; gap: 4px;"><img src="/static/iconfont/pinglun.png" style="width: 14px; height: 14px; opacity: 0.7;" alt="">${(item.statistics && item.statistics.comments) || 0} 评论</span>
					</div>
					<div style="display: flex; gap: 10px;">
						<button class="btn btn-danger btn-sm" onclick="deleteAIContentItem('${safeId}')" style="padding: 4px 12px;">删除</button>
						${(item.statistics && item.statistics.comments > 0) ? `<button class="btn btn-primary btn-sm" onclick='openCommentsModal("${safeId}")' style="padding: 4px 12px;">查看评论 (${item.statistics.comments})</button>` : '<button class="btn btn-secondary btn-sm" disabled style="padding: 4px 12px;">暂无评论</button>'}
					</div>
				</div>
			`;
		}).join('');
		
		// 更新分页
		const pagination = document.getElementById('ai-content-pagination');
		if (pagination) {
			if (data.total > 20) {
				pagination.style.display = 'block';
				const pageInfo = document.getElementById('ai-page-info');
				if (pageInfo) {
					pageInfo.textContent = `第 ${data.page || 1} 页 / 共 ${Math.ceil((data.total || 0) / 20)} 页`;
				}
			} else {
				pagination.style.display = 'none';
			}
		}
	} catch (error) {
		console.error('加载 AI 内容失败:', error);
		showNotification('加载 AI 内容失败', 'error');
	}
}

// 打开 AI 内容编辑弹窗
function openAIContentModal(content = null) {
	const modal = document.getElementById('ai-content-modal');
	if (content) {
		document.getElementById('ai-content-id').value = content.id;
		document.getElementById('ai-content-text').value = content.text;
		document.getElementById('ai-content-side').value = content.side;
		document.getElementById('ai-content-debate-id').value = content.debate_id || '';
	} else {
		document.getElementById('ai-content-form').reset();
		document.getElementById('ai-content-id').value = '';
	}
	modal.classList.add('show');
}

function closeAIContentModal() {
	document.getElementById('ai-content-modal').classList.remove('show');
}

// 评论弹窗
// 打开评论查看弹窗
async function openCommentsModal(contentId) {
		const modal = document.getElementById('comments-modal');
		const listEl = document.getElementById('comments-list');
	
	if (!modal || !listEl) {
		console.error('评论弹窗元素不存在');
		return;
	}
	
	// 显示加载状态
	listEl.innerHTML = '<div style="text-align: center; padding: 40px; color: #999;">加载中...</div>';
	modal.classList.add('show');
	
	try {
		// 调用API获取评论列表（新接口返回格式：{ success: true, data: { contentId, contentText, total, page, pageSize, comments } }）
		const responseData = await fetchAIContentComments(contentId, 1, 50);
		
		// 适配新接口响应格式（apiRequest已经提取了data字段，直接使用）
		// 新接口返回：{ contentId, contentText, total, page, pageSize, comments }
		if (!responseData || !responseData.comments) {
			listEl.innerHTML = '<div class="empty-state">暂无评论</div>';
			return;
		}
		
		const comments = responseData.comments || [];
		
		if (comments.length === 0) {
			listEl.innerHTML = '<div class="empty-state">暂无评论</div>';
			return;
		}
		
		// 清空列表
		listEl.innerHTML = '';
		
		// 显示评论总数（新接口使用 total 字段）
		const header = document.createElement('div');
		header.style.cssText = 'padding: 10px 15px; background: #f5f5f5; border-bottom: 1px solid #e0e0e0; margin: -15px -15px 15px -15px; font-weight: 600;';
		header.textContent = `共 ${responseData.total || comments.length} 条评论`;
		listEl.appendChild(header);
		
		// 渲染评论列表（新接口使用 comment.commentId）
		comments.forEach(comment => {
			const commentEl = document.createElement('div');
			commentEl.style.cssText = 'padding: 15px; border-bottom: 1px solid #eee; background: white;';
			
			// 转义HTML特殊字符防止XSS
			const safeContent = (comment.content || comment.text || '').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
			const safeCommentId = (comment.commentId || comment.id || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
			const safeNickname = (comment.nickname || '匿名用户').replace(/</g, '&lt;').replace(/>/g, '&gt;');
			
			const timestamp = comment.timestamp ? new Date(comment.timestamp).toLocaleString('zh-CN') : '';
			const avatarUrl = comment.avatar || '/static/iconfont/blue-user.png';
			const likes = comment.likes || 0;
			
			commentEl.innerHTML = `
				<div style="display: flex; align-items: center; margin-bottom: 10px;">
					<img src="${avatarUrl}" style="width: 32px; height: 32px; border-radius: 50%; margin-right: 10px; object-fit: cover;" onerror="this.src='/static/iconfont/blue-user.png';" alt="头像">
					<div style="flex: 1;">
						<div style="font-weight: 600; color: #333; margin-bottom: 4px;">${safeNickname}</div>
						<div style="font-size: 12px; color: #999; display: flex; align-items: center; gap: 8px;">
							${timestamp}
							${likes > 0 ? `<span style="display: flex; align-items: center; gap: 4px;"><img src="/static/iconfont/dianzan.png" style="width: 12px; height: 12px; opacity: 0.7;" alt="">${likes}</span>` : ''}
						</div>
					</div>
					<button class="btn btn-sm btn-danger" onclick='deleteComment("${contentId}", "${safeCommentId}")' style="padding: 4px 8px; font-size: 12px;">删除</button>
				</div>
				<div style="color: #333; line-height: 1.6; margin-top: 8px;">${safeContent}</div>
			`;
			
			listEl.appendChild(commentEl);
		});
		
	} catch (error) {
		console.error('加载评论失败:', error);
		listEl.innerHTML = '<div class="empty-state" style="color: #f44336;">加载评论失败: ' + error.message + '</div>';
		showNotification('加载评论失败: ' + error.message, 'error');
	}
}

// 将 openCommentsModal 挂载到 window 对象，供 HTML onclick 调用
window.openCommentsModal = openCommentsModal;

// 删除评论（全局函数，供HTML onclick调用）
window.deleteComment = async function(contentId, commentId) {
	if (!confirm('确定要删除这条评论吗？')) {
		return;
	}
	
	const reason = prompt('请输入删除原因（可选）：');
	
	try {
		const result = await deleteAIContentComment(contentId, commentId, reason || '管理员删除', true);
		if (result) {
			showNotification('评论已删除', 'success');
			// 重新加载评论列表
			await openCommentsModal(contentId);
		}
	} catch (error) {
		console.error('删除评论失败:', error);
		showNotification('删除评论失败: ' + error.message, 'error');
	}
};

document.querySelector('[data-modal="comments-modal"]')?.addEventListener('click', () => {
	document.getElementById('comments-modal').classList.remove('show');
});

document.querySelector('[data-modal="user-votes-modal"]')?.addEventListener('click', () => {
	document.getElementById('user-votes-modal').classList.remove('show');
});

// 添加 AI 内容按钮
document.getElementById('add-ai-content-btn')?.addEventListener('click', () => {
	openAIContentModal();
});

// AI 内容表单提交
document.getElementById('ai-content-form')?.addEventListener('submit', async (e) => {
	e.preventDefault();
	
	const contentId = document.getElementById('ai-content-id').value;
	const contentData = {
		text: document.getElementById('ai-content-text').value,
		side: document.getElementById('ai-content-side').value,
		debate_id: document.getElementById('ai-content-debate-id').value || undefined
	};
	
	try {
		const url = contentId 
			? `${API_BASE}/ai-content/${contentId}`
			: `${API_BASE}/ai-content`;
		
		const method = contentId ? 'PUT' : 'POST';
		
		const response = await fetch(url, {
			method,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(contentData)
		});
		
		const result = await response.json();
		if (result.success) {
			showNotification('保存成功', 'success');
			closeAIContentModal();
			loadAIContent();
		} else {
			throw new Error(result.error || '保存失败');
		}
	} catch (error) {
		console.error('保存失败:', error);
		showNotification('保存失败: ' + error.message, 'error');
	}
});

document.getElementById('cancel-ai-content-btn')?.addEventListener('click', closeAIContentModal);
document.querySelector('[data-modal="ai-content-modal"]')?.addEventListener('click', closeAIContentModal);

// deleteAIContent 函数已在 admin-api.js 中定义
// 删除AI内容的调用通过admin-events.js中的deleteAIContentItem函数处理

// ==================== 数据统计 ====================
const STATS_VOTE_TREND_MAX = 30;
const STATS_VOTE_TREND_INTERVAL_MS = 30000;
let statisticsVoteChart = null;
let statisticsVoteTrendData = { labels: [], left: [], right: [] };
let statisticsVoteTimerId = null;
let statisticsStreamVotesBarChart = null;
let statisticsUserActivityChart = null;
let statisticsUserActivityHourly = [];
let statisticsUserActivityTimerId = null;
let statisticsOverviewTimerId = null; // 未选日期时定时用“今天”数据刷新活跃用户、投票分布
let statisticsQueryMode = 'realtime'; // 'realtime' | 'historical'
let statisticsRangeData = null;

// 有新的累计数据时刷新投票分析图（关播后或票数重置后）；短延迟后拉取并与全部流合并
function refreshStatisticsBarChartFromToday() {
	const page = document.getElementById('statistics');
	if (!page || !page.classList.contains('active')) return;
	if (statisticsQueryMode !== 'realtime') return;
	setTimeout(function () {
		(async function () {
			const todayStr = new Date().toISOString().slice(0, 10);
			try {
				if (typeof fetchStatisticsRange !== 'function') return;
				const res = await fetchStatisticsRange(todayStr, todayStr);
				const d = res?.data || res;
				const day = Array.isArray(d?.dailyStats) && d.dailyStats.length > 0 ? d.dailyStats.find(x => x.date === todayStr) || d.dailyStats[d.dailyStats.length - 1] : null;
				let accumulatedBar = (day && Array.isArray(day.streamVotesBar)) ? day.streamVotesBar : [];
				let streams = [];
				try {
					const r = typeof getStreamsList === 'function' ? await getStreamsList() : [];
					streams = Array.isArray(r) ? r : (r?.data?.streams || r?.streams || []);
				} catch (e) {}
				const useMock = typeof mockGetStreamDisplayData === 'function';
				const byId = {};
				accumulatedBar.forEach(function (s) { byId[s.id] = s; });
				const baseList = streams.length > 0 ? streams : accumulatedBar.map(function (s) { return { id: s.id, name: s.name }; });
				let streamsWithVotes = baseList.map(function (s) {
					const id = s.id;
					const acc = byId[id];
					if (acc) return { id, name: acc.name || s.name, leftVotes: acc.leftVotes || 0, rightVotes: acc.rightVotes || 0 };
					const mock = useMock ? mockGetStreamDisplayData(id) : {};
					return { id, name: s.name, leftVotes: mock.leftVotes ?? s.leftVotes ?? 0, rightVotes: mock.rightVotes ?? s.rightVotes ?? 0 };
				});
				accumulatedBar.forEach(function (s) {
					if (!baseList.some(function (x) { return x.id === s.id; })) {
						streamsWithVotes.push({ id: s.id, name: s.name || s.id, leftVotes: s.leftVotes || 0, rightVotes: s.rightVotes || 0 });
					}
				});
				if (!statisticsStreamVotesBarChart) initStatisticsStreamVotesBarChart();
				updateStatisticsStreamVotesBarChart(streamsWithVotes);
			} catch (e) {}
		})();
	}, 400);
}

function renderStatisticsOverview(data) {
	const page = document.getElementById('statistics');
	if (!page) return;
	let overview = page.querySelector('#stats-overview');
	if (!overview) {
		overview = document.createElement('div');
		overview.id = 'stats-overview';
		overview.style.cssText = 'display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:20px;';
		const statsCards = page.querySelector('.stats-cards');
		page.insertBefore(overview, statsCards || page.firstChild);
	}
	const totalVotes = data.globalTotalVotes ?? data.totalVotes ?? 0;
	const leftVotes = data.leftVotes ?? 0;
	const rightVotes = data.rightVotes ?? 0;
	const voteTotal = leftVotes + rightVotes;
	const leftPct = voteTotal > 0 ? Math.round((leftVotes / voteTotal) * 100) : 50;
	const rightPct = voteTotal > 0 ? (100 - leftPct) : 50;
	const activeSubtitle = data.activeUsersSubtitle || '当日投票>8次计为活跃';
	overview.innerHTML = `
		<div class="stat-card" style="background: white; padding: 20px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
			<h4 style="margin: 0 0 10px 0; color: #333; font-size: 18px; font-weight: 600;">观众总数</h4>
			<div style="font-size: 36px; font-weight: 700; color: #667eea;">${data.totalUsers ?? 0}</div>
			<div style="font-size: 12px; color: #999; margin-top: 4px;">平台注册用户数</div>
		</div>
		<div class="stat-card" style="background: white; padding: 20px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
			<h4 style="margin: 0 0 10px 0; color: #333; font-size: 18px; font-weight: 600;">累计投票</h4>
			<div style="font-size: 36px; font-weight: 700; color: #4CAF50;">${totalVotes}</div>
		</div>
		<div class="stat-card" style="background: white; padding: 20px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
			<h4 style="margin: 0 0 10px 0; color: #333; font-size: 18px; font-weight: 600;">活跃用户</h4>
			<div style="font-size: 36px; font-weight: 700; color: #FF9800;">${data.activeUsers ?? 0}</div>
			<div style="font-size: 12px; color: #999; margin-top: 4px;">${activeSubtitle}</div>
		</div>
		<div class="stat-card" style="background: white; padding: 20px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
			<h4 style="margin: 0 0 10px 0; color: #333; font-size: 18px; font-weight: 600;">投票分布</h4>
			<div style="font-size: 26px; font-weight: 700; color: #2196F3;">正方 ${leftPct}%</div>
			<div style="font-size: 26px; font-weight: 700; color: #f44336;">反方 ${rightPct}%</div>
		</div>
	`;
}

// 各直播流正反方票数柱状图：获取每个直播流名称和正反方票数
function initStatisticsStreamVotesBarChart() {
	const canvas = document.getElementById('stream-votes-bar-chart');
	if (!canvas || typeof Chart === 'undefined') return;
	if (statisticsStreamVotesBarChart) {
		statisticsStreamVotesBarChart.destroy();
		statisticsStreamVotesBarChart = null;
	}
	statisticsStreamVotesBarChart = new Chart(canvas.getContext('2d'), {
		type: 'bar',
		data: {
			labels: [],
			datasets: [
				{ label: '正方', data: [], backgroundColor: 'rgba(52,152,219,0.8)', borderColor: '#3498db', borderWidth: 1 },
				{ label: '反方', data: [], backgroundColor: 'rgba(231,76,60,0.8)', borderColor: '#e74c3c', borderWidth: 1 }
			]
		},
		options: {
			responsive: true,
			maintainAspectRatio: true,
			scales: {
				y: { beginAtZero: true, title: { display: true, text: '票数' } },
				x: { title: { display: true, text: '直播流' } }
			},
			plugins: { legend: { position: 'top' } }
		}
	});
}

function updateStatisticsStreamVotesBarChart(streamsWithVotes) {
	if (!statisticsStreamVotesBarChart || !Array.isArray(streamsWithVotes)) return;
	const labels = streamsWithVotes.map(s => (s.name || s.id || '未命名').slice(0, 12));
	const left = streamsWithVotes.map(s => s.leftVotes || 0);
	const right = streamsWithVotes.map(s => s.rightVotes || 0);
	statisticsStreamVotesBarChart.data.labels = labels;
	statisticsStreamVotesBarChart.data.datasets[0].data = left;
	statisticsStreamVotesBarChart.data.datasets[1].data = right;
	statisticsStreamVotesBarChart.update('none');
}

function initStatisticsVoteChart() {
	const canvas = document.getElementById('vote-analysis-chart');
	if (!canvas || typeof Chart === 'undefined') return;
	if (statisticsVoteChart) {
		statisticsVoteChart.destroy();
		statisticsVoteChart = null;
	}
	statisticsVoteTrendData = { labels: [], left: [], right: [] };
	statisticsVoteChart = new Chart(canvas.getContext('2d'), {
		type: 'line',
		data: {
			labels: statisticsVoteTrendData.labels,
			datasets: [
				{ label: '正方', data: statisticsVoteTrendData.left, borderColor: '#3498db', backgroundColor: 'rgba(52,152,219,0.1)', fill: true, tension: 0.3 },
				{ label: '反方', data: statisticsVoteTrendData.right, borderColor: '#e74c3c', backgroundColor: 'rgba(231,76,60,0.1)', fill: true, tension: 0.3 }
			]
		},
		options: {
			responsive: true,
			maintainAspectRatio: true,
			scales: {
				y: { beginAtZero: true, title: { display: true, text: '票数' } },
				x: { title: { display: true, text: '时间' } }
			},
			plugins: { legend: { position: 'top' } }
		}
	});
}

function startStatisticsVoteTimer() {
	if (statisticsVoteTimerId) return;
	statisticsVoteTimerId = setInterval(() => {
		const page = document.getElementById('statistics');
		if (!page || !page.classList.contains('active')) return;
		if (statisticsQueryMode !== 'realtime') return;
		const isLive = typeof mockIsAnyLive === 'function' ? mockIsAnyLive() : (window.globalState && window.globalState.isLive);
		if (!isLive) return;
		const g = typeof mockGetGlobalDisplayData === 'function' ? mockGetGlobalDisplayData() : {};
		const data = typeof fetchDashboard === 'function' ? (window._lastDashboardStats || g) : g;
		const left = (data && data.leftVotes != null) ? data.leftVotes : (g.leftVotes ?? 0);
		const right = (data && data.rightVotes != null) ? data.rightVotes : (g.rightVotes ?? 0);
		const t = new Date();
		const label = t.getHours().toString().padStart(2,'0') + ':' + t.getMinutes().toString().padStart(2,'0') + ':' + t.getSeconds().toString().padStart(2,'0');
		statisticsVoteTrendData.labels.push(label);
		statisticsVoteTrendData.left.push(left);
		statisticsVoteTrendData.right.push(right);
		if (statisticsVoteTrendData.labels.length > STATS_VOTE_TREND_MAX) {
			statisticsVoteTrendData.labels.shift();
			statisticsVoteTrendData.left.shift();
			statisticsVoteTrendData.right.shift();
		}
		if (statisticsVoteChart) {
			statisticsVoteChart.data.labels = statisticsVoteTrendData.labels;
			statisticsVoteChart.data.datasets[0].data = statisticsVoteTrendData.left;
			statisticsVoteChart.data.datasets[1].data = statisticsVoteTrendData.right;
			statisticsVoteChart.update('none');
		}
	}, STATS_VOTE_TREND_INTERVAL_MS);
}

function stopStatisticsVoteTimer() {
	if (statisticsVoteTimerId) {
		clearInterval(statisticsVoteTimerId);
		statisticsVoteTimerId = null;
	}
}

function initStatisticsUserActivityChart() {
	const canvas = document.getElementById('user-activity-chart');
	if (!canvas || typeof Chart === 'undefined') return;
	if (statisticsUserActivityChart) {
		statisticsUserActivityChart.destroy();
		statisticsUserActivityChart = null;
	}
	const labels = Array.from({ length: 24 }, (_, i) => i + '时');
	statisticsUserActivityHourly = Array(24).fill(0);
	for (let i = 0; i < 24; i++) {
		if (i >= 12 && i <= 21) statisticsUserActivityHourly[i] = 10 + Math.floor(Math.random() * 20);
		else if (i >= 8 && i <= 11) statisticsUserActivityHourly[i] = 5 + Math.floor(Math.random() * 10);
		else if (Math.random() < 0.3) statisticsUserActivityHourly[i] = 1 + Math.floor(Math.random() * 5);
	}
	const activeColor = 'rgba(255,152,0,0.8)';
	const inactiveColor = 'rgba(200,200,200,0.4)';
	statisticsUserActivityChart = new Chart(canvas.getContext('2d'), {
		type: 'bar',
		data: {
			labels,
			datasets: [{
				label: '活跃用户',
				data: statisticsUserActivityHourly.slice(),
				backgroundColor: statisticsUserActivityHourly.map(v => v > 0 ? activeColor : inactiveColor),
				borderColor: statisticsUserActivityHourly.map(v => v > 0 ? '#FF9800' : '#ccc'),
				borderWidth: 1
			}]
		},
		options: {
			responsive: true,
			maintainAspectRatio: true,
			scales: {
				y: { beginAtZero: true, title: { display: true, text: '人数' } },
				x: { title: { display: true, text: '时段（某时活跃则标色）' } }
			},
			plugins: { legend: { position: 'top' } }
		}
	});
}

function updateStatisticsUserActivity(activeUsers) {
	const h = new Date().getHours();
	if (statisticsUserActivityHourly.length === 24) {
		statisticsUserActivityHourly[h] = Math.max(statisticsUserActivityHourly[h], activeUsers || 0);
		if (statisticsUserActivityChart) {
			statisticsUserActivityChart.data.datasets[0].data = statisticsUserActivityHourly.slice();
			const activeColor = 'rgba(255,152,0,0.8)';
			const inactiveColor = 'rgba(200,200,200,0.4)';
			statisticsUserActivityChart.data.datasets[0].backgroundColor = statisticsUserActivityHourly.map(v => v > 0 ? activeColor : inactiveColor);
			statisticsUserActivityChart.data.datasets[0].borderColor = statisticsUserActivityHourly.map(v => v > 0 ? '#FF9800' : '#ccc');
			statisticsUserActivityChart.update('none');
		}
	}
}

function startStatisticsUserActivityTimer() {
	if (statisticsUserActivityTimerId) return;
	function tick() {
		const page = document.getElementById('statistics');
		if (!page || !page.classList.contains('active')) return;
		if (statisticsQueryMode !== 'realtime') return;
		const data = typeof fetchDashboard === 'function' ? (window._lastDashboardStats || {}) : {};
		const activeUsers = data.activeUsers ?? (typeof mockGetGlobalDisplayData === 'function' ? mockGetGlobalDisplayData().activeUsers : 0);
		updateStatisticsUserActivity(activeUsers);
	}
	tick();
	statisticsUserActivityTimerId = setInterval(tick, 60 * 60 * 1000);
}

function stopStatisticsUserActivityTimer() {
	if (statisticsUserActivityTimerId) {
		clearInterval(statisticsUserActivityTimerId);
		statisticsUserActivityTimerId = null;
	}
}

async function loadStatistics() {
	try {
		const page = document.getElementById('statistics');
		if (!page) return;

		const dateFrom = document.getElementById('date-from');
		const dateTo = document.getElementById('date-to');
		const hasRange = dateFrom && dateTo && dateFrom.value && dateTo.value;

		if (hasRange && typeof fetchStatisticsRange === 'function') {
			statisticsQueryMode = 'historical';
			stopStatisticsVoteTimer();
			stopStatisticsUserActivityTimer();
			stopStatisticsOverviewTimer();
			let result;
			try {
				result = await fetchStatisticsRange(dateFrom.value, dateTo.value);
			} catch (e) {
				console.error('日期查询失败', e);
				showNotification('日期查询失败，请稍后重试', 'error');
				return;
			}
			const data = result?.data || result;
			if (!data || (result && result.success === false)) {
				showNotification('暂无该时段历史数据', 'info');
				renderStatisticsOverview({ totalUsers: 0, globalTotalVotes: 0, totalVotes: 0, leftVotes: 0, rightVotes: 0, activeUsers: 0 });
				if (document.getElementById('vote-analysis-chart')) {
					if (!statisticsVoteChart) initStatisticsVoteChart();
					if (statisticsVoteChart) {
						statisticsVoteChart.data.labels = [];
						statisticsVoteChart.data.datasets[0].data = [];
						statisticsVoteChart.data.datasets[1].data = [];
						statisticsVoteChart.update('none');
					}
				}
				if (statisticsStreamVotesBarChart) updateStatisticsStreamVotesBarChart([]);
				if (statisticsUserActivityChart) {
					statisticsUserActivityHourly = Array(24).fill(0);
					statisticsUserActivityChart.data.datasets[0].data = statisticsUserActivityHourly.slice();
					statisticsUserActivityChart.data.datasets[0].backgroundColor = statisticsUserActivityHourly.map(() => 'rgba(200,200,200,0.4)');
					statisticsUserActivityChart.data.datasets[0].borderColor = statisticsUserActivityHourly.map(() => '#ccc');
					statisticsUserActivityChart.update('none');
				}
				return;
			}
			statisticsRangeData = data;
			const totalUsers = data.totalUsers ?? 0;
			const maxActive = data.maxActiveUsers ?? (Array.isArray(data.dailyStats) && data.dailyStats.length
				? Math.max(...data.dailyStats.map(d => (d.activeUsers != null ? d.activeUsers : 0)))
				: 0);
			renderStatisticsOverview({
				totalUsers,
				globalTotalVotes: data.totalVotes ?? 0,
				totalVotes: data.totalVotes ?? 0,
				leftVotes: data.leftVotes ?? 0,
				rightVotes: data.rightVotes ?? 0,
				activeUsers: maxActive,
				activeUsersSubtitle: '区间内单日最高（当日投票>8次计为活跃）'
			});
			if (document.getElementById('vote-analysis-chart')) {
				if (!statisticsVoteChart) initStatisticsVoteChart();
				if (statisticsVoteChart && Array.isArray(data.dailyStats) && data.dailyStats.length > 0) {
					const labels = data.dailyStats.map(d => d.date || '');
					const left = data.dailyStats.map(d => d.leftVotes || 0);
					const right = data.dailyStats.map(d => d.rightVotes || 0);
					statisticsVoteChart.data.labels = labels;
					statisticsVoteChart.data.datasets[0].data = left;
					statisticsVoteChart.data.datasets[1].data = right;
					statisticsVoteChart.update('none');
				} else if (statisticsVoteChart) {
					statisticsVoteChart.data.labels = [];
					statisticsVoteChart.data.datasets[0].data = [];
					statisticsVoteChart.data.datasets[1].data = [];
					statisticsVoteChart.update('none');
				}
			}
			// 柱状图、时段图：使用所选范围结束日期的保存数据
			const chartDay = (data.dailyStats && data.dailyStats.length > 0)
				? data.dailyStats.find(d => d.date === dateTo.value) || data.dailyStats[data.dailyStats.length - 1]
				: null;
			if (!statisticsStreamVotesBarChart) initStatisticsStreamVotesBarChart();
			if (chartDay && Array.isArray(chartDay.streamVotesBar) && chartDay.streamVotesBar.length > 0) {
				updateStatisticsStreamVotesBarChart(chartDay.streamVotesBar);
			} else {
				updateStatisticsStreamVotesBarChart([]);
			}
			if (!statisticsUserActivityChart) initStatisticsUserActivityChart();
			if (chartDay && Array.isArray(chartDay.hourlyActivity) && chartDay.hourlyActivity.length === 24) {
				statisticsUserActivityHourly = chartDay.hourlyActivity.slice();
				statisticsUserActivityChart.data.datasets[0].data = statisticsUserActivityHourly.slice();
				const activeColor = 'rgba(255,152,0,0.8)';
				const inactiveColor = 'rgba(200,200,200,0.4)';
				statisticsUserActivityChart.data.datasets[0].backgroundColor = statisticsUserActivityHourly.map(v => v > 0 ? activeColor : inactiveColor);
				statisticsUserActivityChart.data.datasets[0].borderColor = statisticsUserActivityHourly.map(v => v > 0 ? '#FF9800' : '#ccc');
				statisticsUserActivityChart.update('none');
			} else {
				statisticsUserActivityHourly = Array(24).fill(0);
				statisticsUserActivityChart.data.datasets[0].data = statisticsUserActivityHourly.slice();
				statisticsUserActivityChart.data.datasets[0].backgroundColor = statisticsUserActivityHourly.map(() => 'rgba(200,200,200,0.4)');
				statisticsUserActivityChart.data.datasets[0].borderColor = statisticsUserActivityHourly.map(() => '#ccc');
				statisticsUserActivityChart.update('none');
			}
			return;
		}

		statisticsQueryMode = 'realtime';
		statisticsRangeData = null;
		const result = await fetchDashboard();
		const data = result?.data || result;
		if (data) window._lastDashboardStats = data;
		const todayStr = new Date().toISOString().slice(0, 10);
		let activeUsersByVotes = 0;
		let sumLeft = data?.leftVotes ?? 0;
		let sumRight = data?.rightVotes ?? 0;
		try {
			if (typeof fetchStatisticsActiveUsers === 'function') {
				// 不传 date，服务端用本地“今天”，与历史次数里的日期一致
				const ar = await fetchStatisticsActiveUsers();
				activeUsersByVotes = (ar?.data?.activeUsers != null) ? ar.data.activeUsers : 0;
			}
		} catch (e) { /* 忽略 */ }
		let day = null;
		try {
			if (typeof fetchStatisticsRange === 'function') {
				const res = await fetchStatisticsRange(todayStr, todayStr);
				const d = res?.data || res;
				day = Array.isArray(d?.dailyStats) && d.dailyStats.length > 0 ? d.dailyStats.find(x => x.date === todayStr) || d.dailyStats[d.dailyStats.length - 1] : null;
				if (day && Array.isArray(day.streamVotesBar) && day.streamVotesBar.length > 0) {
					sumLeft = day.streamVotesBar.reduce((s, x) => s + (x.leftVotes || 0), 0);
					sumRight = day.streamVotesBar.reduce((s, x) => s + (x.rightVotes || 0), 0);
				} else if (day && (day.leftVotes != null || day.rightVotes != null)) {
					sumLeft = day.leftVotes ?? 0;
					sumRight = day.rightVotes ?? 0;
				}
			}
		} catch (e) { /* 忽略 */ }
		if (day && typeof day.activeUsers === 'number') activeUsersByVotes = day.activeUsers;
		const displayData = {
			totalUsers: data?.totalUsers ?? 0,
			globalTotalVotes: data?.globalTotalVotes ?? data?.totalVotes ?? 0,
			totalVotes: (sumLeft + sumRight) || data?.globalTotalVotes || data?.totalVotes || 0,
			leftVotes: sumLeft,
			rightVotes: sumRight,
			activeUsers: activeUsersByVotes
		};
		renderStatisticsOverview(displayData);

		if (!statisticsStreamVotesBarChart) initStatisticsStreamVotesBarChart();
		// 投票分析图：当日累计（关播后）优先，与全部流合并显示，避免关播后只看到 0
		(async function loadStatisticsBarChartFromToday() {
			const todayStr = new Date().toISOString().slice(0, 10);
			let accumulatedBar = [];
			try {
				if (typeof fetchStatisticsRange === 'function') {
					const res = await fetchStatisticsRange(todayStr, todayStr);
					const d = res?.data || res;
					const day = Array.isArray(d?.dailyStats) && d.dailyStats.length > 0 ? d.dailyStats.find(x => x.date === todayStr) || d.dailyStats[d.dailyStats.length - 1] : null;
					if (day && Array.isArray(day.streamVotesBar)) accumulatedBar = day.streamVotesBar;
				}
			} catch (e) {}
			let streams = [];
			try {
				const r = typeof getStreamsList === 'function' ? await getStreamsList() : [];
				streams = Array.isArray(r) ? r : (r?.data?.streams || r?.streams || []);
			} catch (e) {}
			const useMock = typeof mockGetStreamDisplayData === 'function';
			const byId = {};
			accumulatedBar.forEach(function (s) { byId[s.id] = s; });
			const baseList = streams.length > 0 ? streams : accumulatedBar.map(function (s) { return { id: s.id, name: s.name }; });
			let streamsWithVotes = baseList.map(function (s) {
				const id = s.id;
				const acc = byId[id];
				if (acc) return { id, name: acc.name || s.name, leftVotes: acc.leftVotes || 0, rightVotes: acc.rightVotes || 0 };
				const mock = useMock ? mockGetStreamDisplayData(id) : {};
				return { id, name: s.name, leftVotes: mock.leftVotes ?? s.leftVotes ?? 0, rightVotes: mock.rightVotes ?? s.rightVotes ?? 0 };
			});
			accumulatedBar.forEach(function (s) {
				if (!baseList.some(function (x) { return x.id === s.id; })) {
					streamsWithVotes.push({ id: s.id, name: s.name || s.id, leftVotes: s.leftVotes || 0, rightVotes: s.rightVotes || 0 });
				}
			});
			updateStatisticsStreamVotesBarChart(streamsWithVotes);
		})();

		if (document.getElementById('vote-analysis-chart')) {
			if (!statisticsVoteChart) initStatisticsVoteChart();
			startStatisticsVoteTimer();
		}
		if (!statisticsUserActivityChart) initStatisticsUserActivityChart();
		startStatisticsUserActivityTimer();
		updateStatisticsUserActivity(displayData.activeUsers);
		startStatisticsOverviewTimer(); // 未选日期时每 30 秒用今天数据刷新活跃用户、投票分布
	} catch (error) {
		console.error('加载统计数据失败:', error);
		showNotification('加载失败', 'error');
	}
}

function stopStatisticsOverviewTimer() {
	if (statisticsOverviewTimerId) {
		clearInterval(statisticsOverviewTimerId);
		statisticsOverviewTimerId = null;
	}
}

async function refreshStatisticsOverviewToday() {
	const page = document.getElementById('statistics');
	if (!page || !page.classList.contains('active')) return;
	if (statisticsQueryMode !== 'realtime') return;
	const todayStr = new Date().toISOString().slice(0, 10);
	let activeUsersByVotes = 0;
	let sumLeft = 0, sumRight = 0;
	const data = window._lastDashboardStats || {};
	try {
		if (typeof fetchStatisticsActiveUsers === 'function') {
			const ar = await fetchStatisticsActiveUsers();
			activeUsersByVotes = (ar?.data?.activeUsers != null) ? ar.data.activeUsers : 0;
		}
	} catch (e) { /* 忽略 */ }
	try {
		if (typeof fetchStatisticsRange === 'function') {
			const res = await fetchStatisticsRange(todayStr, todayStr);
			const d = res?.data || res;
			const day = Array.isArray(d?.dailyStats) && d.dailyStats.length > 0 ? d.dailyStats.find(x => x.date === todayStr) || d.dailyStats[d.dailyStats.length - 1] : null;
			if (day && Array.isArray(day.streamVotesBar) && day.streamVotesBar.length > 0) {
				sumLeft = day.streamVotesBar.reduce((s, x) => s + (x.leftVotes || 0), 0);
				sumRight = day.streamVotesBar.reduce((s, x) => s + (x.rightVotes || 0), 0);
			} else if (day && (day.leftVotes != null || day.rightVotes != null)) {
				sumLeft = day.leftVotes ?? 0;
				sumRight = day.rightVotes ?? 0;
			}
			if (day && typeof day.activeUsers === 'number') activeUsersByVotes = day.activeUsers;
		}
	} catch (e) { /* 忽略 */ }
	const totalVotes = sumLeft + sumRight;
	renderStatisticsOverview({
		totalUsers: data?.totalUsers ?? 0,
		globalTotalVotes: data?.globalTotalVotes ?? data?.totalVotes ?? 0,
		totalVotes: totalVotes || data?.globalTotalVotes || data?.totalVotes || 0,
		leftVotes: sumLeft,
		rightVotes: sumRight,
		activeUsers: activeUsersByVotes
	});
}

function startStatisticsOverviewTimer() {
	if (statisticsOverviewTimerId) return;
	statisticsOverviewTimerId = setInterval(() => {
		refreshStatisticsOverviewToday();
	}, 30000); // 每 30 秒用今天的数据刷新两卡
}

function onLeaveStatisticsPage() {
	stopStatisticsVoteTimer();
	stopStatisticsUserActivityTimer();
	stopStatisticsOverviewTimer();
}

document.getElementById('filter-btn')?.addEventListener('click', () => {
	loadStatistics();
});
document.getElementById('statistics-refresh-btn')?.addEventListener('click', () => {
	loadStatistics();
});

// 全局通知方法，简单 alert 实现，可自定义美化
// ==================== API函数 ====================
// 所有API函数已在admin-api.js中定义，这里不再重复定义
// 如果需要使用API函数，请使用admin-api.js中的函数

// ==================== 辅助函数 ====================

function showNotification(message, type = 'info') {
    // type可以为 'success' | 'error' | 'warning' | 'info'，可扩展美化
    alert(message);
}

// ==================== 多直播管理功能 ====================

// 每个流小卡片的 mock 数据（随机模拟，不依赖真实开播）
function getStreamMockMetrics(streamId) {
	if (!window.__streamMockMetrics) window.__streamMockMetrics = {};
	const m = window.__streamMockMetrics[streamId];
	if (m) return m;
	window.__streamMockMetrics[streamId] = {
		activeUsers: Math.floor(Math.random() * 26) + 5,
		viewers: Math.floor(Math.random() * 31) + 5,
		totalVotes: Math.floor(Math.random() * 190) + 10
	};
	return window.__streamMockMetrics[streamId];
}
function refreshStreamMockMetrics(streamId) {
	if (!window.__streamMockMetrics) window.__streamMockMetrics = {};
	window.__streamMockMetrics[streamId] = {
		activeUsers: Math.floor(Math.random() * 26) + 5,
		viewers: Math.floor(Math.random() * 31) + 5,
		totalVotes: Math.floor(Math.random() * 190) + 10
	};
	return window.__streamMockMetrics[streamId];
}

/**
 * 格式化直播测试时间：开播时间显示为 "开播 HH:mm" 或 "已播 X 分"
 */
function formatStreamStartTime(startTimeIso) {
	if (!startTimeIso) return '';
	try {
		const start = new Date(startTimeIso);
		const now = new Date();
		const diffMs = now - start;
		const diffMin = Math.floor(diffMs / 60000);
		if (diffMin < 1) return '开播 ' + start.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
		if (diffMin < 60) return '已播 ' + diffMin + ' 分';
		const h = Math.floor(diffMin / 60);
		const m = diffMin % 60;
		return '已播 ' + h + ' 时' + (m ? m + ' 分' : '');
	} catch (e) { return startTimeIso || ''; }
}

/**
 * 渲染多直播总览（纯前端 Mock 模拟，不调用直播接口）
 */
async function renderMultiLiveOverview() {
	const container = document.getElementById('multi-live-streams-grid');
	if (!container) return;
	// 禁止刷新回顶：更新前保存滚动位置，更新后恢复
	const scrollY = window.scrollY;
	const scrollX = window.scrollX;
	try {
		console.log('📡 加载多直播总览（Mock 模式）...');
		
		// 仅获取流列表（流管理 API），不调用直播状态 API
		let streams = [];
		try {
			const streamsResult = await (typeof getStreamsList === 'function' ? getStreamsList() : Promise.resolve([]));
			streams = Array.isArray(streamsResult) ? streamsResult : (streamsResult?.data?.streams || streamsResult?.streams || []);
		} catch (e) {
			streams = [];
		}
		
		if (!streams || streams.length === 0) {
			container.innerHTML = `
				<div style="text-align: center; padding: 40px; color: rgba(255,255,255,0.8); grid-column: 1 / -1;">
					<div style="font-size: 32px; margin-bottom: 15px; display: flex; align-items: center; justify-content: center; gap: 8px;">
						<img src="/static/iconfont/live.png" style="width: 32px; height: 32px; filter: brightness(0) invert(1); opacity: 0.7;" alt="">
					</div>
					<div style="font-size: 16px; font-weight: 600; margin-bottom: 8px;">暂无直播流</div>
					<div style="font-size: 13px; opacity: 0.7;">请先在"直播流管理"中添加直播流</div>
				</div>
			`;
			return;
		}
		
		// 已禁用的直播流不展示
		const enabledStreams = streams.filter(s => s.enabled !== false);
		window.liveSetupStreams = streams;
		
		// 使用 Mock 数据（不调用直播 API）
		const useMock = typeof mockGetStreamDisplayData === 'function' && typeof mockGetGlobalDisplayData === 'function';
		const globalData = useMock ? mockGetGlobalDisplayData() : {};
		
		// 渲染流卡片：Mock 时严格用每流独立数据（在线/观看人数各直播间不同，不会三个一样）
		container.innerHTML = enabledStreams.map(stream => {
			const mockData = useMock ? mockGetStreamDisplayData(stream.id) : {};
			const isLive = (typeof mockIsStreamLive === 'function' ? mockIsStreamLive(stream.id) : (stream.liveStatus?.isLive ?? (useMock ? mockData.isLive : false)));
			const streamOnline = useMock ? (mockData.online ?? 0) : (stream.streamOnlineUsers ?? 0);
			const viewers = useMock ? (mockData.viewers ?? 0) : (stream.streamViewersCount ?? 0);
			// 总投票 = 正方+反方（同一数据源，避免票比与总数不同步）
		const totalVotes = useMock ? ((mockData.leftVotes || 0) + (mockData.rightVotes || 0)) : ((stream.leftVotes || 0) + (stream.rightVotes || 0));
			const aiStatus = (window.streamAIStatusesMap && window.streamAIStatusesMap[stream.id]) || 'stopped';
			
			const statusColor = isLive ? '#27ae60' : '#95a5a6';
			const cardBg = isLive ? 'rgba(255,255,255,0.98)' : 'rgba(255,255,255,0.9)';
			const borderColor = isLive ? '#27ae60' : '#dee2e6';
			
			const streamIdAttr = typeof stream.id === 'string' ? stream.id.replace(/"/g, '&quot;') : stream.id;
			const streamNameAttr = (stream.name || 'Unnamed Stream').replace(/'/g, "\\'").replace(/"/g, '&quot;');
			return `
				<div class="stream-card" data-stream-id="${streamIdAttr}" style="
					background: ${cardBg};
					border-radius: 8px;
					padding: 20px;
					border-left: 4px solid ${borderColor};
					border: 1px solid ${borderColor};
					box-shadow: 0 1px 3px rgba(0,0,0,0.08);
					transition: all 0.3s ease;
				">
					<!-- 头部：流名称和状态（无点击事件，仅详情按钮可打开大屏） -->
					<div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 15px;">
						<div style="flex: 1;">
							<h4 style="margin: 0 0 5px 0; color: #2c3e50; font-size: 16px; font-weight: 600;">
								${stream.name || 'Unnamed Stream'}
							</h4>
							<div style="font-size: 12px; color: #6c757d;">
								${stream.type ? stream.type.toUpperCase() : 'UNKNOWN'}
							</div>
						</div>
						<div style="background: ${isLive ? '#27ae60' : '#95a5a6'}; color: white; padding: 4px 12px; border-radius: 4px; font-size: 12px; font-weight: 600; white-space: nowrap; display: flex; align-items: center; gap: 4px; pointer-events: none;">
							<span class="iconfont icon-circle" style="font-size: 10px; opacity: 0.7;"></span>
							${isLive ? '直播中' : '未直播'}
						</div>
					</div>
					
					${isLive && stream.liveStatus?.startTime ? `
					<div style="font-size: 11px; color: #27ae60; margin-bottom: 8px; text-align: center;">
						直播测试时间：${formatStreamStartTime(stream.liveStatus.startTime)}
					</div>
					` : ''}
					<!-- 数据统计 -->
					<div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 15px;">
						<div style="text-align: center; padding: 10px; background: #f8f9fa; border-radius: 6px; border: 1px solid #e9ecef;">
							<div class="stream-online-count" data-stream-id="${stream.id}" style="font-size: 20px; font-weight: 600; color: #3498db; display: flex; align-items: center; justify-content: center; gap: 4px;">
								<img src="/static/iconfont/blue-user.png" style="width: 16px; height: 16px; opacity: 0.8;" alt="">
								<span class="stream-online-num">${streamOnline}</span>
							</div>
							<div style="font-size: 11px; color: #6c757d; margin-top: 4px;">在线人数</div>
						</div>
						<div style="text-align: center; padding: 10px; background: #f8f9fa; border-radius: 6px; border: 1px solid #e9ecef;">
							<div class="stream-viewers" style="font-size: 20px; font-weight: 600; color: #8e44ad; display: flex; align-items: center; justify-content: center; gap: 4px;">
								<img src="/static/iconfont/guankanrenshu.png" style="width: 16px; height: 16px; opacity: 0.8;" alt="">
								${viewers}
							</div>
							<div style="font-size: 11px; color: #6c757d; margin-top: 4px;">观看人数</div>
						</div>
						<div style="text-align: center; padding: 10px; background: #f8f9fa; border-radius: 6px; border: 1px solid #e9ecef;">
							<div class="stream-total-votes" data-stream-id="${stream.id}" style="font-size: 20px; font-weight: 600; color: #34495e; display: flex; align-items: center; justify-content: center; gap: 4px;">
								<img src="/static/iconfont/toupiao.png" style="width: 16px; height: 16px; opacity: 0.8;" alt="">
								<span class="stream-total-votes-num">${totalVotes}</span>
							</div>
							<div style="font-size: 11px; color: #6c757d; margin-top: 4px;">总投票</div>
						</div>
					</div>
					
					<!-- AI状态：水平居中，点击联动 AI 内容管理启动该流 AI 并生成内容 -->
					<div class="stream-ai-status-row" data-stream-id="${stream.id}" data-ai-status="${aiStatus}" style="display: flex; align-items: center; justify-content: center; gap: 8px; padding: 8px; background: #f8f9fa; border-radius: 6px; margin-bottom: 12px; border: 1px solid #e9ecef; cursor: pointer; text-align: center;" onclick="event.stopPropagation(); toggleStreamAI('${stream.id}', '${aiStatus}');" title="点击启动/停止该流 AI 识别并生成辩论内容">
						<img src="/static/iconfont/gongjigongju.png" style="width: 14px; height: 14px; opacity: 0.5;" alt="">
						<span class="stream-ai-status-text" style="font-size: 12px; color: #6c757d;">${aiStatus === 'running' ? 'AI: 已启动' : 'AI: 未启动'}</span>
					</div>
					
					<!-- 操作按钮：开始/关闭共用一个区域，点击「开始」→ 开播并变为「关闭」；点击「关闭」→ 停播并变为「开始」 -->
					<div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
						<button 
							type="button"
							class="btn btn-sm mock-stream-btn ${isLive ? 'btn-danger' : 'btn-success'}"
							data-stream-id="${streamIdAttr}"
							style="min-width: 110px; padding: 10px 22px; font-size: 14px; display: flex; align-items: center; justify-content: center; gap: 6px;"
						>
							${isLive ? '<span class="iconfont icon-stop" style="font-size: 14px;"></span>关闭' : '<img src="/static/iconfont/bofang.png" style="width: 14px; height: 14px; filter: brightness(0) invert(1);" alt="">开始'}
						</button>
						<button 
							class="btn btn-sm btn-secondary"
							style="padding: 8px 14px; font-size: 13px; display: flex; align-items: center; gap: 4px; justify-content: center; margin-left: auto;"
							onclick="event.stopPropagation(); viewStreamVoteDetail('${streamIdAttr}', '${streamNameAttr}')"
						>
							<img src="/static/iconfont/shuju.png" style="width: 14px; height: 14px; opacity: 0.7;" alt="">
							详情
						</button>
					</div>
				</div>
			`;
		}).join('');
		
		// 更新全局统计（Mock 模式）
		if (typeof updateMockGlobalStats === 'function') updateMockGlobalStats();
		
		console.log(`✅ 多直播总览已加载（Mock 模式，${enabledStreams.length} 个流）`);
		
	} catch (error) {
		console.error('❌ 加载多直播总览失败:', error);
		container.innerHTML = `
			<div style="text-align: center; padding: 40px; color: rgba(255,255,255,0.8); grid-column: 1 / -1;">
				<div style="font-size: 32px; margin-bottom: 15px; display: flex; align-items: center; justify-content: center; gap: 8px;">
					<span class="iconfont icon-warning" style="font-size: 32px; filter: brightness(0) invert(1);"></span>
				</div>
				<div style="font-size: 16px; font-weight: 600; margin-bottom: 8px;">加载失败</div>
				<div style="font-size: 13px; opacity: 0.7;">${error.message}</div>
				<button class="btn btn-sm" style="margin-top: 15px; background: rgba(255,255,255,0.2); color: white; border: 1px solid rgba(255,255,255,0.3); display: inline-flex; align-items: center; gap: 6px; padding: 8px 16px;" onclick="refreshMultiLiveOverview()">
					<img src="/static/iconfont/shuaxin.png" style="width: 14px; height: 14px; filter: brightness(0) invert(1);" alt="">
					重试
				</button>
			</div>
		`;
	} finally {
		requestAnimationFrame(function() { window.scrollTo(scrollX, scrollY); });
	}
}

/**
 * 刷新多直播总览：重新获取流列表并渲染
 */
function refreshMultiLiveOverview() {
	renderMultiLiveOverview();
}

/**
 * 切换流的AI状态（未启动则启动，运行中则停止）
 */
async function toggleStreamAI(streamId, currentStatus) {
	if (!streamId) return;
	if (currentStatus === 'running') {
		try {
			if (typeof stopAI === 'function') {
				await stopAI(streamId, true, true);
				showNotification('AI已停止', 'success');
				if (typeof renderMultiLiveOverview === 'function') renderMultiLiveOverview();
			}
		} catch (e) {
			console.error('停止AI失败:', e);
			showNotification('停止AI失败: ' + (e.message || e), 'error');
		}
	} else {
		try {
			if (typeof startAI === 'function') {
				await startAI({}, streamId, true);
				window.streamAIStatusesMap = window.streamAIStatusesMap || {};
				window.streamAIStatusesMap[streamId] = 'running';
				showNotification('AI已启动', 'success');
				if (typeof renderMultiLiveOverview === 'function') renderMultiLiveOverview();
			}
		} catch (e) {
			console.error('启动AI失败:', e);
			showNotification('启动AI失败: ' + (e.message || e), 'error');
		}
	}
}

// 详情（比分大屏）：从 Dashboard 拉取正反方票数，与多直播卡片同源，Mock 直播时也能正确显示
function viewStreamVoteDetail(streamId, streamName) {
	if (!streamId) return;
	const streamIdStr = String(streamId);
	const name = streamName || (window.liveSetupStreams?.find(s => s.id === streamId)?.name) || '直播流';
	const prev = document.getElementById('stream-vote-detail-modal');
	if (prev) prev.remove();
	const safeName = (name || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	const overlay = document.createElement('div');
	overlay.id = 'stream-vote-detail-modal';
	overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;';
	overlay.innerHTML = `
		<div id="stream-vote-detail-box" style="width:90%;max-width:420px;background:#fff;border-radius:12px;box-shadow:0 8px 40px rgba(0,0,0,0.3);display:flex;flex-direction:column;overflow:hidden;">
			<div style="display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid #eee;">
				<h3 style="margin:0;font-size:18px;color:#333;">${safeName} - 票数</h3>
				<button type="button" id="stream-vote-detail-close" style="background:none;border:none;font-size:24px;cursor:pointer;color:#666;">×</button>
			</div>
			<div style="padding:24px;display:flex;gap:24px;justify-content:center;align-items:center;">
				<div style="text-align:center;padding:20px 28px;background:linear-gradient(135deg,#e74c3c 0%,#c0392b 100%);border-radius:10px;color:#fff;">
					<div style="font-size:14px;margin-bottom:8px;">正方票数</div>
					<div id="detail-left-num" style="font-size:32px;font-weight:700;">0</div>
				</div>
				<div style="text-align:center;padding:20px 28px;background:linear-gradient(135deg,#3498db 0%,#2980b9 100%);border-radius:10px;color:#fff;">
					<div style="font-size:14px;margin-bottom:8px;">反方票数</div>
					<div id="detail-right-num" style="font-size:32px;font-weight:700;">0</div>
				</div>
			</div>
		</div>
	`;
	document.body.appendChild(overlay);
	var detailPollTimer = null;
	function stopPoll() {
		if (detailPollTimer) clearInterval(detailPollTimer);
		detailPollTimer = null;
	}
	function applyVotes(left, right) {
		var ln = document.getElementById('detail-left-num');
		var rn = document.getElementById('detail-right-num');
		if (ln) ln.textContent = Number(left) || 0;
		if (rn) rn.textContent = Number(right) || 0;
	}
		function refreshVotes() {
			if (!document.getElementById('stream-vote-detail-modal')) return;
			if (typeof fetchDashboardByStream === 'function') {
				fetchDashboardByStream(streamIdStr).then(function(data) {
					if (!data) return;
					var d = data.data || data;
					// 只显示直播时的本场票数，默认 0；未直播一律 0:0，不显示当前票数（历史/手动可能很大）
					var isLive = (d.liveStatus && d.liveStatus.isLive) || !!d.isLive;
					var left = 0, right = 0;
					if (isLive) {
						left = d.liveSessionLeft != null ? d.liveSessionLeft : (d.leftVotes != null ? d.leftVotes : 0);
						right = d.liveSessionRight != null ? d.liveSessionRight : (d.rightVotes != null ? d.rightVotes : 0);
					}
					applyVotes(left, right);
				}).catch(function() {});
			}
		}
	overlay.addEventListener('click', function(e) { if (e.target === overlay) { stopPoll(); overlay.remove(); } });
	document.getElementById('stream-vote-detail-close').onclick = function() { stopPoll(); overlay.remove(); };
	document.getElementById('stream-vote-detail-box').addEventListener('click', function(e) { e.stopPropagation(); });
	refreshVotes();
	detailPollTimer = setInterval(refreshVotes, 2500);
}

function closeStreamDetailModalIfOpen() {
	const m = document.getElementById('stream-vote-detail-modal');
	if (m) m.remove();
}

function initMultiLiveFeatures() {
	renderMultiLiveOverview();
	
	// 定时刷新（每10秒）
	setInterval(() => {
		const dashboardPage = document.getElementById('dashboard');
		if (dashboardPage && dashboardPage.classList.contains('active')) {
			renderMultiLiveOverview();
		}
	}, 10000);
}

// 页面加载时初始化
document.addEventListener('DOMContentLoaded', () => {
	// 延迟初始化，等待其他组件加载完成
	setTimeout(() => {
		initMultiLiveFeatures();
	}, 1000);
});