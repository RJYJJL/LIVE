/**
 * 数据概览页面 - 纯前端 Mock 模拟
 * 全程仅做前端 Mock，不调用任何真实直播接口
 *
 * 投票规则（与后端一致）：
 * - 普通用户：1次投票行为=2票，全投正方或全投反方，历史投票次数+1
 * - 单场票数 = 用户投票次数×2 + 3位评委各10票
 * - 全局总票数 = Σ(用户投票次数×2) + Σ(评委票数)
 * - 投票趋势图：每次模拟+2票，反映"1次投票=2票"规则
 */
(function() {
	'use strict';

	if (!window.globalState) window.globalState = { isLive: false };

	// Mock 状态存储。平台在线人数 28-35 随机、可有浮动；卡片在线=该直播间人数，比平台少
	window.mockDashboardState = window.mockDashboardState || {
		liveStreamIds: new Set(),
		streamData: {},
		globalOnline: 0,
		totalOnlineUsers: 28 + Math.floor(Math.random() * 8),
		totalUsers: 38,
		leftVotes: 0,
		rightVotes: 0,
		cumulativeTotalVotes: 0
	};

	const MOCK = window.mockDashboardState;

	// 统一 streamId 类型（数字/字符串均可），避免「关闭」按钮因类型不一致关不上
	function normId(streamId) {
		return streamId == null ? '' : String(streamId);
	}

	function getStreamData(streamId) {
		const id = normId(streamId);
		if (!MOCK.streamData[id]) {
			MOCK.streamData[id] = { online: 0, viewers: 0, leftVotes: 0, rightVotes: 0, votedUserIds: new Set(), judgeVotes: [] };
		}
		return MOCK.streamData[id];
	}

	const JUDGES_PER_STREAM = 3;  // 直播时评委一定在线
	const MAX_AUDIENCE = 35;      // 观众池上限（用户可在直播间跳转）

	// 各卡片在线之和不超过平台在线人数（28-35 随机）
	function getPlatformOnlineCap() {
		return Math.max(28, Math.min(35, MOCK.totalOnlineUsers || 32));
	}
	const TOTAL_ONLINE_CAP = 35;
	function initStreamMockData(streamId, initialOnline) {
		const d = getStreamData(streamId);
		d.online = Math.max(3, Math.min(initialOnline || (3 + Math.floor(Math.random() * 3)), TOTAL_ONLINE_CAP));
		d.viewers = Math.max(d.viewers || 0, d.online);
		d.leftVotes = d.leftVotes || 0;
		d.rightVotes = d.rightVotes || 0;
		d.votedUserIds = d.votedUserIds || new Set();
	}
	function sumStreamOnline() {
		let s = 0;
		MOCK.liveStreamIds.forEach(id => { s += getStreamData(id).online || 0; });
		const cap = getPlatformOnlineCap();
		return Math.min(cap, s);
	}

	// 同步 Mock 直播状态到服务器（评委在线、用户状态）
	function syncMockLiveToServer() {
		if (typeof syncMockLiveState === 'function') {
			syncMockLiveState(Array.from(MOCK.liveStreamIds)).catch(() => {});
		}
	}

	window._mockAutoCloseTimers = window._mockAutoCloseTimers || {};
	window._mockForceVoteTimers = window._mockForceVoteTimers || {};
	window._mockVoteStepTimers = window._mockVoteStepTimers || {};
	window._mockViewerRampTimers = window._mockViewerRampTimers || {};
	window._mockJudgeVoteTimers = window._mockJudgeVoteTimers || {};
	window._mockAutoCloseAllTimer = null;
	window._mockForceVoteAllTimer = null;
	function clearStreamTimers(streamId) {
		const id = normId(streamId);
		if (window._mockAutoCloseTimers[id]) {
			clearTimeout(window._mockAutoCloseTimers[id]);
			delete window._mockAutoCloseTimers[id];
		}
		if (window._mockForceVoteTimers[id]) {
			clearTimeout(window._mockForceVoteTimers[id]);
			delete window._mockForceVoteTimers[id];
		}
		if (window._mockVoteStepTimers && window._mockVoteStepTimers[id]) {
			clearTimeout(window._mockVoteStepTimers[id]);
			delete window._mockVoteStepTimers[id];
		}
		if (window._mockViewerRampTimers && window._mockViewerRampTimers[id]) {
			clearInterval(window._mockViewerRampTimers[id]);
			delete window._mockViewerRampTimers[id];
		}
		if (window._mockJudgeVoteTimers && window._mockJudgeVoteTimers[id]) {
			clearTimeout(window._mockJudgeVoteTimers[id]);
			delete window._mockJudgeVoteTimers[id];
		}
	}
	function doOneVoteStep(streamId) {
		const id = normId(streamId);
		if (!MOCK.liveStreamIds.has(id)) return;
		const d = getStreamData(id);
		d.votedUserIds = d.votedUserIds || new Set();
		const online = d.online || 0;
		const pool = Array.from({ length: Math.max(0, online) }, (_, i) => 'v_' + id + '_' + i);
		const canVote = pool.filter(uid => !d.votedUserIds.has(uid));
		if (canVote.length === 0) return;
		const uid = canVote[Math.floor(Math.random() * canVote.length)];
		d.votedUserIds.add(uid);
		const side = Math.random() < 0.5 ? 'left' : 'right';
		if (side === 'left') d.leftVotes = (d.leftVotes || 0) + 2; else d.rightVotes = (d.rightVotes || 0) + 2;
		MOCK.cumulativeTotalVotes = (MOCK.cumulativeTotalVotes || 0) + 2;
		if (typeof renderMultiLiveOverview === 'function') renderMultiLiveOverview();
		if (typeof updateMockGlobalStats === 'function') updateMockGlobalStats();
		if (typeof updateVotes === 'function') updateVotes('set', d.leftVotes || 0, d.rightVotes || 0, 'mock同步', true, id).catch(function() {});
		const g = mockGetGlobalDisplayData();
		if (typeof appendVoteTrendPoint === 'function') appendVoteTrendPoint(g.leftVotes, g.rightVotes);
	}
	function scheduleNextVoteStep(streamId) {
		const id = normId(streamId);
		if (!MOCK.liveStreamIds.has(id)) return;
		doOneVoteStep(id);
		const delay = 6000 + Math.floor(Math.random() * 2000);
		window._mockVoteStepTimers = window._mockVoteStepTimers || {};
		window._mockVoteStepTimers[id] = setTimeout(function() { scheduleNextVoteStep(id); }, delay);
	}
	// 直播间人数
	function startViewerRamp(streamId) {
		const id = normId(streamId);
		if (window._mockViewerRampTimers && window._mockViewerRampTimers[id]) return;
		const TARGET_VIEWERS = 15;
		const STEP_MS = 8000;
		const MAX_STEPS = 6;
		let steps = 0;
		window._mockViewerRampTimers = window._mockViewerRampTimers || {};
		window._mockViewerRampTimers[id] = setInterval(function() {
			if (!MOCK.liveStreamIds.has(id) || steps >= MAX_STEPS) {
				if (window._mockViewerRampTimers && window._mockViewerRampTimers[id]) {
					clearInterval(window._mockViewerRampTimers[id]);
					delete window._mockViewerRampTimers[id];
				}
				return;
			}
			const d = getStreamData(id);
			const cap = getPlatformOnlineCap();
			const add = 2 + Math.floor(Math.random() * 2);
			d.viewers = Math.min((d.viewers || 0) + add, Math.max(TARGET_VIEWERS, 20));
			d.online = Math.min(d.viewers, cap);
			steps++;
			if (typeof renderMultiLiveOverview === 'function') renderMultiLiveOverview();
			if (typeof updateMockGlobalStats === 'function') updateMockGlobalStats();
		}, STEP_MS);
	}

	// 评委投票：约 25 秒后 3 位评委各投 10 票（正方/反方随机）
	function scheduleJudgeVote(streamId) {
		const id = normId(streamId);
		window._mockJudgeVoteTimers = window._mockJudgeVoteTimers || {};
		window._mockJudgeVoteTimers[id] = setTimeout(function() {
			if (!MOCK.liveStreamIds.has(id)) return;
			const d = getStreamData(id);
			if (d.judgeVotes && d.judgeVotes.length > 0) return;
			const judgeVotes = [
				{ judgeId: 'judge-1', votedSide: Math.random() < 0.5 ? 'left' : 'right', votes: 10 },
				{ judgeId: 'judge-2', votedSide: Math.random() < 0.5 ? 'left' : 'right', votes: 10 },
				{ judgeId: 'judge-3', votedSide: Math.random() < 0.5 ? 'left' : 'right', votes: 10 }
			];
			judgeVotes.forEach(jv => {
				if (jv.votedSide === 'left') d.leftVotes = (d.leftVotes || 0) + jv.votes;
				else d.rightVotes = (d.rightVotes || 0) + jv.votes;
			});
			d.judgeVotes = judgeVotes;
			MOCK.cumulativeTotalVotes = (MOCK.cumulativeTotalVotes || 0) + 30;
			if (typeof renderMultiLiveOverview === 'function') renderMultiLiveOverview();
			if (typeof updateMockGlobalStats === 'function') updateMockGlobalStats();
			if (typeof updateVotes === 'function') updateVotes('set', d.leftVotes || 0, d.rightVotes || 0, 'mock评委同步', true, id).catch(function() {});
			if (typeof appendVoteTrendPoint === 'function') {
				const g = mockGetGlobalDisplayData();
				appendVoteTrendPoint(g.leftVotes, g.rightVotes);
			}
		}, 25000);
	}

	function scheduleStreamAutoCloseAndVote(streamId) {
		const id = normId(streamId);
		clearStreamTimers(id);
		startViewerRamp(id);
		scheduleJudgeVote(id);
		// 40 秒后才开始产生投票，40 秒前一票都没有；之后每 6~8 秒随机执行一次投票行为
		window._mockForceVoteTimers[id] = setTimeout(function() {
			if (!MOCK.liveStreamIds.has(id)) return;
			scheduleNextVoteStep(id);
		}, 40000);
		window._mockAutoCloseTimers[id] = setTimeout(function() {
			if (typeof mockStopStream === 'function') mockStopStream(id);
			clearStreamTimers(id);
			if (typeof renderMultiLiveOverview === 'function') renderMultiLiveOverview();
			if (typeof updateMockGlobalStats === 'function') updateMockGlobalStats();
		}, 60000);
	}

	// Mock：开始所有直播。卡片在线之和不超过平台在线（28-35）
	window.mockStartAllLive = function(streamIds) {
		(streamIds || []).forEach(rawId => {
			MOCK.liveStreamIds.add(normId(rawId));
		});
		let remaining = getPlatformOnlineCap();
		MOCK.liveStreamIds.forEach(id => {
			const cap = Math.max(3, remaining);
			const n = Math.min(3 + Math.floor(Math.random() * 3), cap); // 3-5 人
			const d = getStreamData(id);
			d.online = n;
			d.viewers = n;  // 每次重新开播观看人数初始化，本场进过该间的人数从当前房间人数起
			d.leftVotes = 0;
			d.rightVotes = 0;
			d.votedUserIds = new Set();
			remaining -= n;
			if (typeof updateVotes === 'function') updateVotes('set', 0, 0, 'mock开播重置', false, id).catch(function() {});
		});
		MOCK.globalOnline = sumStreamOnline();
		window.globalState.isLive = true;
		syncMockLiveToServer();
		if (typeof resetVoteTrendOnLiveStart === 'function') resetVoteTrendOnLiveStart();
		MOCK.liveStreamIds.forEach(function(streamId) {
			startViewerRamp(streamId);
			scheduleJudgeVote(streamId);
		});
		if (window._mockForceVoteAllTimer) clearTimeout(window._mockForceVoteAllTimer);
		if (window._mockAutoCloseAllTimer) clearTimeout(window._mockAutoCloseAllTimer);
		// 40 秒后才开始产生投票，之后每 6~8 秒每个流随机执行一次投票行为
		window._mockForceVoteAllTimer = setTimeout(function() {
			MOCK.liveStreamIds.forEach(function(streamId) {
				if (MOCK.liveStreamIds.has(streamId)) scheduleNextVoteStep(streamId);
			});
		}, 40000);
		window._mockAutoCloseAllTimer = setTimeout(function() {
			if (typeof mockStopAllLive === 'function') mockStopAllLive();
			window._mockForceVoteAllTimer = null;
			window._mockAutoCloseAllTimer = null;
		}, 60000);
	};

	// Mock：停止所有直播，清空当前直播数据；取消 1 分钟/40 秒投票定时器
	window.mockStopAllLive = function() {
		if (window._mockForceVoteAllTimer) { clearTimeout(window._mockForceVoteAllTimer); window._mockForceVoteAllTimer = null; }
		if (window._mockAutoCloseAllTimer) { clearTimeout(window._mockAutoCloseAllTimer); window._mockAutoCloseAllTimer = null; }
		MOCK.liveStreamIds.forEach(id => clearStreamTimers(id));
		MOCK.liveStreamIds.forEach(id => {
			const d = getStreamData(id);
			d.online = 0;
			d.viewers = 0;
			d.leftVotes = 0;
			d.rightVotes = 0;
			d.votedUserIds = new Set();
		});
		MOCK.liveStreamIds.clear();
		MOCK.globalOnline = 0;
		MOCK.cumulativeTotalVotes = 0;
		window.globalState.isLive = false;
		syncMockLiveState([]).catch(() => {});
	};

	// Mock：开始单个流。1 分钟自动关闭，40 秒后开始每 6~8 秒一次投票
	window.mockStartStream = function(streamId) {
		const id = normId(streamId);
		clearStreamTimers(id);
		MOCK.liveStreamIds.add(id);
		const otherOnline = sumStreamOnline() - (getStreamData(id).online || 0);
		const cap = Math.max(0, getPlatformOnlineCap() - otherOnline);
		initStreamMockData(id, Math.min(3 + Math.floor(Math.random() * 3), Math.max(3, cap)));
		const d = getStreamData(id);
		d.leftVotes = 0;
		d.rightVotes = 0;
		d.viewers = 0;  // 重新开播就重新计算，与总票数一致
		d.votedUserIds = new Set();
		MOCK.globalOnline = sumStreamOnline();
		window.globalState.isLive = true;
		syncMockLiveToServer();
		if (typeof resetVoteTrendOnLiveStart === 'function') resetVoteTrendOnLiveStart();
		scheduleStreamAutoCloseAndVote(id);
	};

	// Mock：停止单个流，该流在线归零，票数保留；取消该流的 1 分钟/40 秒投票定时器
	window.mockStopStream = function(streamId) {
		const id = normId(streamId);
		clearStreamTimers(id);
		const d = getStreamData(id);
		d.online = 0;
		MOCK.liveStreamIds.delete(id);
		MOCK.globalOnline = sumStreamOnline();
		if (MOCK.liveStreamIds.size === 0) {
			window.globalState.isLive = false;
			MOCK.globalOnline = 0;
			syncMockLiveState([]).catch(() => {});
		} else {
			MOCK.globalOnline = sumStreamOnline();
			syncMockLiveToServer();
		}
	};

	// Mock：是否任一流在直播
	window.mockIsAnyLive = function() {
		return MOCK.liveStreamIds.size > 0;
	};

	// Mock：某流是否在直播
	window.mockIsStreamLive = function(streamId) {
		return MOCK.liveStreamIds.has(normId(streamId));
	};

	// Mock：获取流的展示数据。未开播时在线0、票数保留（维持最后比分）；观看人数结束仍显示；开播前全0
	window.mockGetStreamDisplayData = function(streamId) {
		const id = normId(streamId);
		const isLive = MOCK.liveStreamIds.has(id);
		const d = getStreamData(id);
		const totalVotes = (d.leftVotes || 0) + (d.rightVotes || 0);
		return {
			isLive,
			online: isLive ? d.online : 0,
			viewers: d.viewers || 0,
			totalVotes,
			leftVotes: d.leftVotes || 0,
			rightVotes: d.rightVotes || 0,
			judgeVotes: d.judgeVotes || []
		};
	};

	// Mock：获取全局展示数据。紫色导航栏总投票数 = 各直播间票数之和，下次直播继续累加（仅增不减）
	window.mockGetGlobalDisplayData = function() {
		const isLive = MOCK.liveStreamIds.size > 0;
		const liveIds = Array.from(MOCK.liveStreamIds);
		const liveData = liveIds.map(id => getStreamData(id));
		const leftVotes = liveData.reduce((s, d) => s + (d.leftVotes || 0), 0);
		const rightVotes = liveData.reduce((s, d) => s + (d.rightVotes || 0), 0);
		const currentSum = leftVotes + rightVotes;
		// 累计总票数 = 历史累计，不低于当前各流之和（直播中只增不减）
		if (currentSum > (MOCK.cumulativeTotalVotes || 0)) MOCK.cumulativeTotalVotes = currentSum;
		return {
			isLive,
			totalUsers: MOCK.totalUsers,
			activeUsers: MOCK.totalOnlineUsers != null ? MOCK.totalOnlineUsers : MOCK.globalOnline,
			totalVotes: MOCK.cumulativeTotalVotes || 0,
			leftVotes,
			rightVotes
		};
	};

	// 测试用快速真实模拟：平台在线 28-35 浮动；卡片在线/观看人数浮动（观看人数随进人增加）
	let mockDataTimer = null;
	function startMockDataSimulation() {
		if (mockDataTimer) return;
		mockDataTimer = setInterval(() => {
			const cap = getPlatformOnlineCap();
			if (MOCK.totalOnlineUsers == null) MOCK.totalOnlineUsers = 28 + Math.floor(Math.random() * 8);
			if (Math.random() < 0.55) {
				if (Math.random() < 0.5 && MOCK.totalOnlineUsers < 35) MOCK.totalOnlineUsers += 1;
				else if (MOCK.totalOnlineUsers > 28) MOCK.totalOnlineUsers -= 1;
			}
			MOCK.totalOnlineUsers = Math.max(28, Math.min(35, MOCK.totalOnlineUsers));
			if (MOCK.liveStreamIds.size === 0) {
				if (typeof updateMockGlobalStats === 'function') updateMockGlobalStats();
				return;
			}
			const liveIds = Array.from(MOCK.liveStreamIds);
			const currentSum = sumStreamOnline();
			const headroom = Math.max(0, cap - currentSum);
			for (let i = 0; i < liveIds.length; i++) {
				const d = getStreamData(liveIds[i]);
				if (Math.random() < 0.5 && headroom > 0) {
					d.online = Math.min((d.online || 0) + 1, cap);
					d.viewers = Math.max(d.viewers || 0, d.online);
				} else if ((d.online || 0) > 1) {
					d.online = (d.online || 0) - 1;
				}
				if (Math.random() < 0.35) d.viewers = Math.min((d.viewers || 0) + 1, (d.online || 0) + 8);
			}
			MOCK.globalOnline = sumStreamOnline();
			if (typeof renderMultiLiveOverview === 'function') renderMultiLiveOverview();
			if (typeof updateMockGlobalStats === 'function') updateMockGlobalStats();
		}, 2000);
	}

	function stopMockDataSimulation() {
		if (mockDataTimer) {
			clearInterval(mockDataTimer);
			mockDataTimer = null;
		}
	}

	// 缓存用户 ID 列表（用于投票模拟记录到 DB）
	let cachedUserIds = [];
	async function ensureUserIds() {
		if (cachedUserIds.length > 0) return;
		try {
			const res = await fetch((window.SERVER_CONFIG?.BASE_URL || '') + '/api/v1/admin/users?page=1&pageSize=50');
			const json = await res.json();
			const users = json?.data?.users || json?.users || [];
			cachedUserIds = users.filter(u => u.status !== 'banned').map(u => u.userId || u.id).filter(Boolean);
		} catch (e) {}
	}

	// 投票模拟：每人每场 1 次投票=2 票，不造假。有几个人投就算几张票（2*人数），历史可查
	let mockVoteTimer = null;
	function startMockVoteSimulation() {
		if (mockVoteTimer) return;
		mockVoteTimer = setInterval(async () => {
			if (MOCK.liveStreamIds.size === 0) return;
			await ensureUserIds();
			const liveIds = Array.from(MOCK.liveStreamIds);
			for (const streamId of liveIds) {
				const d = getStreamData(streamId);
				d.votedUserIds = d.votedUserIds || new Set();
				const online = d.online || 0;
				const maxVoters = Math.max(0, online - 3);
				const capVotes = 30 + 2 * maxVoters;
				const totalVotes = (d.leftVotes || 0) + (d.rightVotes || 0);
				if (totalVotes >= capVotes || maxVoters <= 0) continue;
				const pool = cachedUserIds.length ? cachedUserIds : Array.from({ length: online }, (_, i) => 'v' + i);
				const canVote = pool.filter(uid => !d.votedUserIds.has(uid));
				if (canVote.length === 0) continue;
				const uid = canVote[Math.floor(Math.random() * canVote.length)];
				d.votedUserIds.add(uid);
				const side = Math.random() < 0.5 ? 'left' : 'right';
				if (side === 'left') d.leftVotes = (d.leftVotes || 0) + 2; else d.rightVotes = (d.rightVotes || 0) + 2;
				MOCK.cumulativeTotalVotes = (MOCK.cumulativeTotalVotes || 0) + 2;
				if (typeof mockRecordVote === 'function') {
					mockRecordVote(streamId, uid, side).then(() => {
						if (typeof loadUsers === 'function') loadUsers();
					}).catch(() => {});
				}
			}
			if (typeof renderMultiLiveOverview === 'function') renderMultiLiveOverview();
			if (typeof updateMockGlobalStats === 'function') updateMockGlobalStats();
			if (typeof updateVotesChart === 'function') {
				const g = mockGetGlobalDisplayData();
				updateVotesChart({ leftVotes: g.leftVotes, rightVotes: g.rightVotes, isLive: true });
			}
		}, 3500);
	}

	function stopMockVoteSimulation() {
		if (mockVoteTimer) {
			clearInterval(mockVoteTimer);
			mockVoteTimer = null;
		}
	}

	// 根据直播状态启停模拟
	window.mockUpdateSimulationTimers = function() {
		if (MOCK.liveStreamIds.size > 0) {
			startMockDataSimulation();
			startMockVoteSimulation();
		} else {
			stopMockDataSimulation();
			stopMockVoteSimulation();
		}
	};

	// 更新全局统计显示
	window.updateMockGlobalStats = function() {
		const g = window.mockGetGlobalDisplayData();
		const totalUsersEl = document.getElementById('total-users');
		const activeUsersEl = document.getElementById('active-users');
		const totalVotesEl = document.getElementById('total-votes');
		const liveStatusEl = document.getElementById('live-status');
		const liveStatusTextEl = document.getElementById('live-status-text');
		if (totalUsersEl) totalUsersEl.textContent = g.totalUsers;
		if (activeUsersEl) activeUsersEl.textContent = g.activeUsers;
		if (totalVotesEl) {
			const v = g.totalVotes != null ? g.totalVotes : (parseInt(totalVotesEl.textContent, 10) || 0);
			if (v > 0 || !totalVotesEl.textContent || totalVotesEl.textContent === '0') totalVotesEl.textContent = v;
		}
		if (liveStatusEl) {
			liveStatusEl.innerHTML = g.isLive
				? '<span style="color: #27ae60;">直播中</span>'
				: '<span style="color: #95a5a6;">未直播</span>';
		}
		if (liveStatusTextEl) liveStatusTextEl.textContent = g.isLive ? '直播中' : '未直播';
		// 右上角「开始直播」仅由用户点击切换，不随 Mock 状态变化
	};

	// 初始化：平台在线 28-35 随机
	window.mockInitDashboard = function() {
		MOCK.totalOnlineUsers = MOCK.totalOnlineUsers != null ? MOCK.totalOnlineUsers : (28 + Math.floor(Math.random() * 8));
		MOCK.totalOnlineUsers = Math.max(28, Math.min(35, MOCK.totalOnlineUsers));
		MOCK.globalOnline = sumStreamOnline();
		updateMockGlobalStats();
	};

	// Mock：控制单个流开始/停止（纯前端状态切换，无 API 调用）
	window.mockControlStreamLive = function(streamId, start) {
		const id = normId(streamId);
		if (!id) return;
		if (start) {
			mockStartStream(id);
		} else {
			mockStopStream(id);
		}
		mockUpdateSimulationTimers();
		if (typeof renderMultiLiveOverview === 'function') renderMultiLiveOverview();
		if (typeof updateMockGlobalStats === 'function') updateMockGlobalStats();
	};
})();
