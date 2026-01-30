// 简单的文件数据库（可用于生产环境使用真实数据库替换）
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DB_DIR = path.join(__dirname, '../data');
const DB_FILES = {
	streams: path.join(DB_DIR, 'streams.json'),
	debate: path.join(DB_DIR, 'debate.json'),
	streamDebates: path.join(DB_DIR, 'stream-debates.json'),
	debateFlows: path.join(DB_DIR, 'debate-flows.json'),
	judges: path.join(DB_DIR, 'judges.json'),
	users: path.join(DB_DIR, 'users.json'),
	statistics: path.join(DB_DIR, 'statistics.json'),
	liveSchedule: path.join(DB_DIR, 'live-schedule.json'),
	votes: path.join(DB_DIR, 'votes.json'),
	streamViewers: path.join(DB_DIR, 'stream-viewers.json')
};

// 确保数据目录存在
if (!fs.existsSync(DB_DIR)) {
	fs.mkdirSync(DB_DIR, { recursive: true });
}

// 初始化默认数据
function initDefaultData() {
	// 初始化直播流
	if (!fs.existsSync(DB_FILES.streams)) {
		fs.writeFileSync(DB_FILES.streams, JSON.stringify([], null, 2));
	}
	
	// 初始化辩论设置
	if (!fs.existsSync(DB_FILES.debate)) {
		fs.writeFileSync(DB_FILES.debate, JSON.stringify({
			title: "如果有一个能一键消除痛苦的按钮，你会按吗？",
			description: "这是一个关于痛苦、成长与人性选择的深度辩论",
			leftPosition: "会按",
			rightPosition: "不会按"
		}, null, 2));
	}
	
	// 初始化用户数据
	if (!fs.existsSync(DB_FILES.users)) {
		fs.writeFileSync(DB_FILES.users, JSON.stringify([], null, 2));
	}
	
	// 初始化统计数据
	if (!fs.existsSync(DB_FILES.statistics)) {
		fs.writeFileSync(DB_FILES.statistics, JSON.stringify({
			totalVotes: 0,
			totalUsers: 0,
			dailyStats: []
		}, null, 2));
	}
	
	// 初始化直播计划
	if (!fs.existsSync(DB_FILES.liveSchedule)) {
		fs.writeFileSync(DB_FILES.liveSchedule, JSON.stringify({
			scheduledStartTime: null,
			scheduledEndTime: null,
			streamId: null,
			debateId: null,
			isScheduled: false
		}, null, 2));
	}
	// 每个直播流关联的辩题 { streamId: debateObj }
	if (!fs.existsSync(DB_FILES.streamDebates)) {
		fs.writeFileSync(DB_FILES.streamDebates, JSON.stringify({}, null, 2));
	}
	// 每个直播流的辩论流程 { streamId: { segments: [...] } }
	if (!fs.existsSync(DB_FILES.debateFlows)) {
		fs.writeFileSync(DB_FILES.debateFlows, JSON.stringify({}, null, 2));
	}
	// 每个直播流的评委配置 { streamId: { judges: [...], replacedUserIds: [...] } }
	if (!fs.existsSync(DB_FILES.judges)) {
		fs.writeFileSync(DB_FILES.judges, JSON.stringify({}, null, 2));
	}
	// 每个直播流票数持久化 { streamId: { leftVotes, rightVotes } }，直播结束后保留
	if (!fs.existsSync(DB_FILES.votes)) {
		fs.writeFileSync(DB_FILES.votes, JSON.stringify({}, null, 2));
	}
	// 每个直播流累计观看人数（只增不减，直播停止后保留，下次开播在原有基础上继续累加）
	if (!fs.existsSync(DB_FILES.streamViewers)) {
		fs.writeFileSync(DB_FILES.streamViewers, JSON.stringify({}, null, 2));
	}
}

// 读取数据
function readData(key) {
	try {
		const data = fs.readFileSync(DB_FILES[key], 'utf8');
		return JSON.parse(data);
	} catch (error) {
		if (error.code === 'ENOENT') {
			initDefaultData();
			return readData(key);
		}
		throw error;
	}
}

// 写入数据
function writeData(key, data) {
	fs.writeFileSync(DB_FILES[key], JSON.stringify(data, null, 2));
}

// 直播流管理
const streams = {
	getAll: () => readData('streams'),
	
	getById: (id) => {
		const streams = readData('streams');
		return streams.find(s => s.id === id);
	},
	
	create: (streamData) => {
		const streams = readData('streams');
		const newStream = {
			id: uuidv4(),
			...streamData,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString()
		};
		streams.push(newStream);
		writeData('streams', streams);
		return newStream;
	},
	
	// add方法作为create的别名，方便使用
	add: function(streamData) {
		return this.create(streamData);
	},
	
	update: (id, streamData) => {
		const streams = readData('streams');
		const index = streams.findIndex(s => s.id === id);
		if (index === -1) return null;
		
		streams[index] = {
			...streams[index],
			...streamData,
			updatedAt: new Date().toISOString()
		};
		writeData('streams', streams);
		return streams[index];
	},
	
	delete: (id) => {
		const streams = readData('streams');
		const filtered = streams.filter(s => s.id !== id);
		writeData('streams', filtered);
		return filtered.length < streams.length;
	},
	
	toggle: (id) => {
		const streams = readData('streams');
		const index = streams.findIndex(s => s.id === id);
		if (index === -1) return null;
		
		streams[index].enabled = !streams[index].enabled;
		streams[index].updatedAt = new Date().toISOString();
		writeData('streams', streams);
		return streams[index];
	},
	
	getActive: () => {
		const streams = readData('streams');
		return streams.find(s => s.enabled === true);
	}
};

// 每个直播流关联的辩题（本地存储，列表修改后立即可见）
function readStreamDebates() {
	try {
		const data = readData('streamDebates');
		return typeof data === 'object' && data !== null ? data : {};
	} catch (e) {
		initDefaultData();
		return {};
	}
}
function writeStreamDebates(obj) {
	writeData('streamDebates', obj);
}
const streamDebates = {
	get: (streamId) => {
		const map = readStreamDebates();
		return map[streamId] || null;
	},
	set: (streamId, debate) => {
		const map = readStreamDebates();
		map[streamId] = { id: streamId, ...debate, updatedAt: new Date().toISOString() };
		writeStreamDebates(map);
		return map[streamId];
	},
	remove: (streamId) => {
		const map = readStreamDebates();
		delete map[streamId];
		writeStreamDebates(map);
	}
};

// 辩论流程（环节）管理 { streamId: { segments: [{ name, duration, side }] } }
function readDebateFlows() {
	try {
		const data = readData('debateFlows');
		return typeof data === 'object' && data !== null ? data : {};
	} catch (e) {
		initDefaultData();
		return {};
	}
}
function writeDebateFlows(obj) {
	writeData('debateFlows', obj);
}
const debateFlows = {
	get: (streamId) => {
		const map = readDebateFlows();
		const flow = map[streamId];
		return flow && Array.isArray(flow.segments) ? { segments: flow.segments } : { segments: [] };
	},
	set: (streamId, segments) => {
		const map = readDebateFlows();
		map[streamId] = { segments: segments || [], updatedAt: new Date().toISOString() };
		writeDebateFlows(map);
		return map[streamId];
	},
	remove: (streamId) => {
		const map = readDebateFlows();
		delete map[streamId];
		writeDebateFlows(map);
	}
};

// 辩论设置管理
const debate = {
	get: () => readData('debate'),
	
	update: (debateData) => {
		const current = readData('debate');
		const updated = {
			...current,
			...debateData,
			updatedAt: new Date().toISOString()
		};
		writeData('debate', updated);
		return updated;
	}
};

// 用户管理
const users = {
	getAll: () => readData('users'),
	
	getById: (id) => {
		const users = readData('users');
		return users.find(u => u.id === id);
	},
	
	createOrUpdate: (userData) => {
		const users = readData('users');
		const index = users.findIndex(u => u.id === userData.id);
		
		if (index === -1) {
			// 新用户
			const newUser = {
				...userData,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				totalVotes: 0,
				joinedDebates: 0,
				status: 'active'
			};
			users.push(newUser);
			writeData('users', users);
			return newUser;
		} else {
			// 更新用户
			users[index] = {
				...users[index],
				...userData,
				updatedAt: new Date().toISOString()
			};
			writeData('users', users);
			return users[index];
		}
	},
	
	updateStats: (id, stats) => {
		const users = readData('users');
		const index = users.findIndex(u => u.id === id);
		if (index === -1) return null;
		
		users[index].totalVotes = (users[index].totalVotes || 0) + (stats.votes || 0);
		users[index].joinedDebates = (users[index].joinedDebates || 0) + (stats.debates || 0);
		users[index].updatedAt = new Date().toISOString();
		writeData('users', users);
		return users[index];
	},

	/**
	 * 设置用户状态：online/offline/banned/active 等
	 */
	setStatus: (id, status) => {
		const users = readData('users');
		const index = users.findIndex(u => u.id === id);
		if (index === -1) return null;
		users[index].status = status;
		users[index].updatedAt = new Date().toISOString();
		writeData('users', users);
		return users[index];
	},

	/**
	 * 追加一条投票记录，并维护历史投票次数 voteTimes
	 * 规则：1次投票行为 → voteTimes +1（不是 +votes）
	 * 普通用户：1次投票=2票，全投正方或全投反方
	 * 评委：1次投票=10票
	 * record: { streamId, liveId, side, votes, at }
	 */
	appendVoteRecord: (id, record) => {
		const users = readData('users');
		const index = users.findIndex(u => u.id === id);
		if (index === -1) return null;
		if (!Array.isArray(users[index].voteHistory)) users[index].voteHistory = [];
		users[index].voteHistory.unshift(record);
		users[index].voteTimes = (users[index].voteTimes || 0) + 1;  // 每次投票行为 +1
		users[index].updatedAt = new Date().toISOString();
		writeData('users', users);
		return users[index];
	},

	getVoteHistory: (id) => {
		const users = readData('users');
		const user = users.find(u => u.id === id);
		if (!user) return [];
		return Array.isArray(user.voteHistory) ? user.voteHistory : [];
	}
};

// 统计数据管理
const statistics = {
	get: () => readData('statistics'),
	
	incrementVotes: (count = 1) => {
		const stats = readData('statistics');
		stats.totalVotes = (stats.totalVotes || 0) + count;
		writeData('statistics', stats);
		return stats;
	},
	
	updateDashboard: (data) => {
		const stats = readData('statistics');
		// 更新传入的字段
		if (data.totalVotes !== undefined) {
			stats.totalVotes = data.totalVotes;
		}
		if (data.lastLiveTime !== undefined) {
			stats.lastLiveTime = data.lastLiveTime;
		}
		if (data.liveDuration !== undefined) {
			stats.liveDuration = data.liveDuration;
		}
		// 更新其他可能的字段
		if (data.totalUsers !== undefined) {
			stats.totalUsers = data.totalUsers;
		}
		if (data.totalComments !== undefined) {
			stats.totalComments = data.totalComments;
		}
		if (data.totalLikes !== undefined) {
			stats.totalLikes = data.totalLikes;
		}
		stats.updatedAt = new Date().toISOString();
		writeData('statistics', stats);
		return stats;
	},
	
	getDashboard: () => {
		const stats = readData('statistics');
		const users = readData('users');
		const streams = readData('streams');
		const activeStream = streams.find(s => s.enabled);
		
		return {
			totalUsers: users.length,
			activeUsers: users.filter(u => u.status === 'active').length,
			totalVotes: stats.totalVotes || 0,
			isLive: !!activeStream
		};
	},

	/**
	 * 按日期更新或插入每日统计（用于柱状图、时段图持久化）
	 * entry: { date, totalVotes?, leftVotes?, rightVotes?, activeUsers?, streamVotesBar?, hourlyActivity? }
	 */
	upsertDailyStat: (dateStr, entry) => {
		const stats = readData('statistics');
		if (!Array.isArray(stats.dailyStats)) stats.dailyStats = [];
		const idx = stats.dailyStats.findIndex(d => d.date === dateStr);
		const row = {
			date: dateStr,
			totalVotes: entry.totalVotes ?? 0,
			leftVotes: entry.leftVotes ?? 0,
			rightVotes: entry.rightVotes ?? 0,
			activeUsers: entry.activeUsers ?? 0,
			streamVotesBar: entry.streamVotesBar ?? null,
			hourlyActivity: entry.hourlyActivity ?? null
		};
		if (idx >= 0) {
			stats.dailyStats[idx] = { ...stats.dailyStats[idx], ...row };
		} else {
			stats.dailyStats.push(row);
			stats.dailyStats.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
		}
		writeData('statistics', stats);
		return stats.dailyStats.find(d => d.date === dateStr);
	}
};

// 直播计划管理
const liveSchedule = {
	get: () => readData('liveSchedule'),
	
	update: (scheduleData) => {
		const current = readData('liveSchedule');
		const updated = {
			...current,
			...scheduleData,
			updatedAt: new Date().toISOString()
		};
		writeData('liveSchedule', updated);
		return updated;
	},
	
	clear: () => {
		const cleared = {
			scheduledStartTime: null,
			scheduledEndTime: null,
			streamId: null,
			debateId: null,
			isScheduled: false,
			updatedAt: new Date().toISOString()
		};
		writeData('liveSchedule', cleared);
		return cleared;
	}
};

// 初始化
initDefaultData();

// 评委配置管理 { streamId: { judges: [{ id, name, role, avatar, votes, userId? }], replacedUserIds: [...] } }
function readJudges() {
	try {
		const data = readData('judges');
		return typeof data === 'object' && data !== null ? data : {};
	} catch (e) {
		initDefaultData();
		return {};
	}
}
function writeJudges(obj) {
	writeData('judges', obj);
}
// 票数持久化 { streamId: { leftVotes, rightVotes } }
function readVotes() {
	try {
		const data = readData('votes');
		return typeof data === 'object' && data !== null ? data : {};
	} catch (e) {
		initDefaultData();
		return {};
	}
}
function writeVotes(obj) {
	writeData('votes', obj);
}
const votes = {
	get: (streamId) => {
		const map = readVotes();
		const v = map[streamId];
		return v && (typeof v.leftVotes === 'number' || typeof v.rightVotes === 'number')
			? { leftVotes: Math.max(0, v.leftVotes || 0), rightVotes: Math.max(0, v.rightVotes || 0) }
			: { leftVotes: 0, rightVotes: 0 };
	},
	set: (streamId, leftVotes, rightVotes) => {
		const map = readVotes();
		map[streamId] = {
			leftVotes: Math.max(0, parseInt(leftVotes, 10) || 0),
			rightVotes: Math.max(0, parseInt(rightVotes, 10) || 0),
			updatedAt: new Date().toISOString()
		};
		writeVotes(map);
		return map[streamId];
	},
	getAll: () => readVotes()
};

// 每个直播流累计观看人数（只增不减，持久化）
function readStreamViewers() {
	try {
		const data = readData('streamViewers');
		return typeof data === 'object' && data !== null ? data : {};
	} catch (e) {
		initDefaultData();
		return {};
	}
}
function writeStreamViewers(obj) {
	writeData('streamViewers', obj);
}
const streamViewersDb = {
	get: (streamId) => {
		const map = readStreamViewers();
		return Math.max(0, parseInt(map[streamId], 10) || 0);
	},
	set: (streamId, count) => {
		const map = readStreamViewers();
		map[streamId] = Math.max(0, parseInt(count, 10) || 0);
		writeStreamViewers(map);
		return map[streamId];
	},
	add: (streamId, delta) => {
		const map = readStreamViewers();
		const cur = Math.max(0, parseInt(map[streamId], 10) || 0);
		const next = Math.max(0, cur + (parseInt(delta, 10) || 0));
		map[streamId] = next;
		writeStreamViewers(map);
		return next;
	},
	getAll: () => readStreamViewers()
};

const judges = {
	get: (streamId) => {
		const map = readJudges();
		const cfg = map[streamId];
		if (!cfg || !Array.isArray(cfg.judges)) {
			return {
				judges: [
					{ id: 'judge-1', name: '评委1', role: '主评委', avatar: '/admin/assets/images/judges/osmanthus.jpg', votes: 10 },
					{ id: 'judge-2', name: '评委2', role: '嘉宾评委', avatar: '/admin/assets/images/judges/osmanthus.jpg', votes: 10 },
					{ id: 'judge-3', name: '评委3', role: '嘉宾评委', avatar: '/admin/assets/images/judges/osmanthus.jpg', votes: 10 }
				],
				replacedUserIds: []
			};
		}
		return { judges: cfg.judges, replacedUserIds: cfg.replacedUserIds || [] };
	},
	set: (streamId, judgesList, replacedUserIds = []) => {
		const map = readJudges();
		map[streamId] = { judges: judgesList || [], replacedUserIds: replacedUserIds || [], updatedAt: new Date().toISOString() };
		writeJudges(map);
		return map[streamId];
	},
	remove: (streamId) => {
		const map = readJudges();
		delete map[streamId];
		writeJudges(map);
	}
};

module.exports = {
	streams,
	debate,
	streamDebates,
	debateFlows,
	judges,
	users,
	statistics,
	liveSchedule,
	votes,
	streamViewersDb
};

