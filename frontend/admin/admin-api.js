// 后台管理系统API调用模块
// 本文件包含所有与服务器交互的API函数

// 服务器配置（从admin.js继承）
const getAPIBase = () => {
	// 优先使用admin.js中的配置
	if (window.SERVER_CONFIG && window.SERVER_CONFIG.BASE_URL) {
		return window.SERVER_CONFIG.BASE_URL;
	}
	// 默认使用真实后端服务器（如果admin.js未加载）
	if (typeof window !== 'undefined' && window.location && window.location.origin) {
		return window.location.origin;
	}
	return 'http://localhost:8080';
};

// 📋 说明：API 走同源，由网关 (8080) 代理到后端 (127.0.0.1:8000)

// ==================== 多直播管理API ====================

/**
 * 获取指定流的 Dashboard 数据
 * @param {string} streamId - 直播流ID
 * @returns {Promise<Object>}
 */
async function fetchDashboardByStream(streamId) {
	if (!streamId) {
		console.warn('⚠️ fetchDashboardByStream: streamId 为空，使用默认Dashboard');
		return await fetchDashboard();
	}
	
	console.log(`📡 [fetchDashboardByStream] 查询流 ${streamId} 的 Dashboard...`);
	
	// 🔧 关键：使用带 stream_id 参数的 API，确保获取特定流的状态
	const result = await apiRequest(`/api/v1/admin/dashboard?stream_id=${streamId}`, {
		method: 'GET'
	});
	
	console.log(`📊 [fetchDashboardByStream] 流 ${streamId} 的响应:`, {
		aiStatus: result?.aiStatus,
		isLive: result?.isLive,
		streamId: result?.streamId
	});
	
	return result;
}

/**
 * 批量获取多个流的 Dashboard 数据
 * @param {string[]} streamIds - 直播流ID数组
 * @returns {Promise<Object[]>}
 */
async function fetchMultiStreamsDashboard(streamIds) {
	if (!Array.isArray(streamIds) || streamIds.length === 0) {
		console.warn('⚠️ fetchMultiStreamsDashboard: streamIds 无效');
		return [];
	}
	
	// 并行请求所有流的数据
	const promises = streamIds.map(id => fetchDashboardByStream(id));
	const results = await Promise.allSettled(promises);
	
	return results.map((result, index) => ({
		streamId: streamIds[index],
		success: result.status === 'fulfilled',
		data: result.status === 'fulfilled' ? result.value : null,
		error: result.status === 'rejected' ? result.reason : null
	}));
}

/**
 * 获取所有流的实时状态（增强版）
 * @returns {Promise<Object[]>}
 */
async function fetchAllStreamsStatus() {
	const streamsResult = await getStreamsList();
	if (!streamsResult) return [];
	const streams = Array.isArray(streamsResult)
		? streamsResult
		: (streamsResult.data?.streams || streamsResult.streams || streamsResult.data || []);
	if (!Array.isArray(streams) || streams.length === 0) return [];
	
	// 为每个流获取详细状态
	const streamIds = streams.map(s => s.id);
	const dashboardData = await fetchMultiStreamsDashboard(streamIds);
	
	// 合并流信息和Dashboard数据
	return streams.map((stream, index) => ({
		...stream,
		dashboardData: dashboardData[index]
	}));
}

// ==================== 通用请求函数 ====================

// 获取认证Token（如果需要）
function getAuthToken() {
	// 从localStorage或sessionStorage获取token
	if (typeof window !== 'undefined') {
		return localStorage.getItem('admin_token') || sessionStorage.getItem('admin_token') || null;
	}
	return null;
}

async function apiRequest(endpoint, options = {}) {
	const API_BASE = getAPIBase();
	const url = `${API_BASE}${endpoint}`;
	
	// 准备请求头
	const headers = {
		'Content-Type': 'application/json',
		...options.headers
	};
	
	// 如果是v1接口，添加认证token（如果存在）
	if (endpoint.startsWith('/api/v1/')) {
		const token = getAuthToken();
		if (token) {
			headers['Authorization'] = `Bearer ${token}`;
		}
	}
	
	try {
		console.log(`📡 API 请求: ${options.method || 'GET'} ${endpoint}`, options.body ? JSON.parse(options.body) : '');
		console.log(`📡 完整URL: ${url}`);
		
		// 添加超时控制（30秒）
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 30000);
		
		const response = await fetch(url, {
			...options,
			headers,
			mode: 'cors', // 明确指定 CORS 模式
			credentials: 'omit', // 不发送 credentials，避免 CORS 问题
			signal: controller.signal
		}).finally(() => {
			clearTimeout(timeoutId);
		});
		
		console.log(`📥 收到响应: ${response.status} ${response.statusText}`);
		
		// 检查响应类型
		const contentType = response.headers.get('content-type');
		let data;
		
		if (contentType && contentType.includes('application/json')) {
			try {
				data = await response.json();
				console.log('📦 JSON 数据解析成功');
			} catch (parseError) {
				console.error('❌ JSON 解析失败:', parseError);
				const text = await response.text();
				console.error('❌ 响应内容:', text.substring(0, 500));
				throw new Error(`JSON解析失败: ${parseError.message}`);
			}
		} else {
			// 如果不是 JSON，可能是 HTML 错误页面（如 nginx 404）
			const text = await response.text();
			console.error('❌ 收到非 JSON 响应:', text.substring(0, 200));
			console.error('❌ 响应状态:', response.status, response.statusText);
			console.error('❌ 响应头:', Object.fromEntries(response.headers.entries()));
			
			if (text.includes('nginx') || response.headers.get('server') === 'nginx/1.29.3') {
				throw new Error('请求被 nginx 拦截，请确保 nginx 已停止。执行: sudo nginx -s stop 或 killall -9 nginx');
			}
			throw new Error(`服务器返回非 JSON 响应: ${response.status} ${response.statusText}`);
		}
		
		console.log('📦 API 原始响应:', {
			status: response.status,
			statusText: response.statusText,
			data: data
		});
		
		if (!response.ok) {
			const errorMsg = data.message || data.error || `请求失败: ${response.status}`;
			console.error(`❌ HTTP 错误 (${response.status}):`, errorMsg, data);
			throw new Error(errorMsg);
		}
		
		// 检查是否有success字段，如果没有但数据存在，可能是旧格式
		if (data.success === false) {
			throw new Error(data.message || '请求失败');
		}
		
		// 如果没有success字段但有数据，尝试兼容处理
		if (data.success === undefined && data) {
			console.warn('⚠️ API响应缺少success字段，尝试兼容处理:', data);
			// 如果返回的是数组或对象（但不是错误对象），直接返回
			if (Array.isArray(data) || (typeof data === 'object' && !data.error && !data.message)) {
				return data;
			}
		}
		
		// 如果data.success为true，返回data.data，否则返回整个data
		const result = data.success !== undefined ? (data.data || data) : data;
		console.log('✅ API 响应成功:', result);
		return result;
		
	} catch (error) {
		console.error(`❌ API 错误 (${endpoint}):`, error);
		console.error('❌ 错误类型:', error.name);
		console.error('❌ 错误消息:', error.message);
		console.error('❌ 错误堆栈:', error.stack);
		
		// 详细的错误信息
		if (error.name === 'AbortError') {
			console.error('❌ 请求超时: 服务器在30秒内没有响应');
			console.error('   请检查服务器是否正常运行');
		} else if (error.name === 'TypeError' && error.message.includes('fetch')) {
			console.error('❌ 网络错误: 无法连接到服务器，请检查：');
			console.error('   1. 服务器是否已启动');
			console.error('   2. 服务器地址是否正确:', getAPIBase());
			console.error('   3. 是否有防火墙阻止');
			console.error('   4. nginx 是否在拦截请求');
		} else if (error.message.includes('nginx')) {
			console.error('❌ nginx 拦截错误: 请停止 nginx 服务');
			console.error('   执行命令: sudo nginx -s stop 或 killall nginx');
		}
		
		return null;
	}
}

// ==================== 直播控制接口 ====================

/**
 * 开始直播
 * @param {string|null} streamId - 直播流ID（多直播模式下必填，根据接口文档要求）
 * @param {boolean} autoStartAI - 是否自动启动AI识别
 * @param {boolean} notifyUsers - 是否推送通知给用户
 * @returns {Promise<Object|null>}
 */
async function startLive(streamId = null, autoStartAI = false, notifyUsers = true) {
	// 根据接口文档，streamId 是必填的
	if (!streamId || streamId.trim() === '') {
		console.error('❌ startLive: streamId 是必填参数，不能为空');
		return {
			success: false,
			error: 'streamId 是必填参数，请先选择直播流',
			message: 'streamId 是必填参数，请先选择直播流'
		};
	}
	
	return await apiRequest('/api/v1/admin/live/start', {
		method: 'POST',
		body: JSON.stringify({
			streamId: streamId.trim(), // 确保 streamId 存在且不为空
			autoStartAI: autoStartAI || false,
			notifyUsers: notifyUsers !== false // 默认true
		})
	});
}

/**
 * 停止直播
 * @param {string|null} streamId - 直播流ID（多直播模式下必填，根据接口文档要求）
 * @param {boolean} saveStatistics - 是否保存统计数据
 * @param {boolean} notifyUsers - 是否推送通知给用户
 * @returns {Promise<Object|null>}
 */
async function stopLive(streamId = null, saveStatistics = true, notifyUsers = true) {
	// 根据接口文档，streamId 是必填的
	if (!streamId || streamId.trim() === '') {
		console.error('❌ stopLive: streamId 是必填参数，不能为空');
		return {
			success: false,
			error: 'streamId 是必填参数，请先选择直播流',
			message: 'streamId 是必填参数，请先选择直播流'
		};
	}
	
	return await apiRequest('/api/v1/admin/live/stop', {
		method: 'POST',
		body: JSON.stringify({
			streamId: streamId.trim(), // 确保 streamId 存在且不为空
			saveStatistics: saveStatistics !== false, // 默认true
			notifyUsers: notifyUsers !== false // 默认true
		})
	});
}

/**
 * 更新投票数据
 * @param {string} action - 操作类型：'set'(设置) | 'add'(增加) | 'reset'(重置)
 * @param {number} leftVotes - 正方票数
 * @param {number} rightVotes - 反方票数
 * @param {string} reason - 操作原因
 * @param {boolean} notifyUsers - 是否推送通知给用户
 * @returns {Promise<Object|null>}
 */
async function updateVotes(action, leftVotes, rightVotes, reason = '', notifyUsers = true, streamId = null) {
	const body = {
		action,
		leftVotes,
		rightVotes,
		reason,
		notifyUsers
	};
	
	// 如果提供了streamId，添加到请求中
	if (streamId) {
		body.streamId = streamId;
	}
	
	return await apiRequest('/api/v1/admin/live/update-votes', {
		method: 'POST',
		body: JSON.stringify(body)
	});
}

/**
 * 重置投票数据（设为初始值，默认0，可修改为其他数字）
 * @param {number} leftVotes - 重置为的正方票数（默认0）
 * @param {number} rightVotes - 重置为的反方票数（默认0）
 * @param {boolean} saveBackup - 是否备份当前数据
 * @param {boolean} notifyUsers - 是否推送通知给用户
 * @param {string|null} streamId - 直播流ID
 * @param {string} reason - 调整原因（可选）
 */
async function resetVotes(leftVotes = 0, rightVotes = 0, saveBackup = true, notifyUsers = true, streamId = null, reason = '') {
	const body = {
		resetTo: { leftVotes, rightVotes },
		saveBackup,
		notifyUsers,
		reason: reason || '重置票数'
	};
	if (streamId) body.streamId = streamId;
	return await apiRequest('/api/v1/admin/live/reset-votes', {
		method: 'POST',
		body: JSON.stringify(body)
	});
}

// ==================== AI控制接口 ====================

/**
 * 启动AI识别
 * @param {Object} settings - AI设置
 * @param {string|null} streamId - 直播流ID（可选，绑定后会自动启动音频提取）
 * @param {boolean} notifyUsers - 是否推送通知给用户
 * @returns {Promise<Object|null>}
 */
async function startAI(settings = {}, streamId = null, notifyUsers = true) {
	const requestBody = {
		settings: {
			mode: settings.mode || 'realtime',
			sensitivity: settings.sensitivity || 'high',
			minConfidence: settings.minConfidence || 0.7
		},
		notifyUsers
	};
	
	// 如果提供了 streamId，添加到请求体中
	if (streamId) {
		requestBody.streamId = streamId;
	}
	
	return await apiRequest('/api/v1/admin/ai/start', {
		method: 'POST',
		body: JSON.stringify(requestBody)
	});
}

/**
 * 停止AI识别
 * @param {string|null} streamId - 直播流ID（可选，若传入会确保对应音频提取器停止）
 * @param {boolean} saveHistory - 是否保存历史
 * @param {boolean} notifyUsers - 是否推送通知给用户
 * @returns {Promise<Object|null>}
 */
async function stopAI(streamId = null, saveHistory = true, notifyUsers = true) {
	const requestBody = {
		saveHistory,
		notifyUsers
	};
	
	// 如果提供了 streamId，添加到请求体中
	if (streamId) {
		requestBody.streamId = streamId;
	}
	
	return await apiRequest('/api/v1/admin/ai/stop', {
		method: 'POST',
		body: JSON.stringify(requestBody)
	});
}

/**
 * 暂停/恢复AI识别
 * @param {string} action - 'pause'(暂停) | 'resume'(恢复)
 * @param {boolean} notifyUsers - 是否推送通知给用户
 * @returns {Promise<Object|null>}
 */
async function toggleAI(action, notifyUsers = true) {
	return await apiRequest('/api/v1/admin/ai/toggle', {
		method: 'POST',
		body: JSON.stringify({
			action,
			notifyUsers
		})
	});
}

/**
 * 删除AI内容
 * @param {string} contentId - 内容ID
 * @param {string} reason - 删除原因
 * @param {boolean} notifyUsers - 是否推送通知给用户
 * @returns {Promise<Object|null>}
 */
async function deleteAIContent(contentId, reason = '管理员删除', notifyUsers = true) {
	return await apiRequest(`/api/admin/ai-content/${contentId}`, {
		method: 'DELETE',
		body: JSON.stringify({
			reason,
			notifyUsers
		})
	});
}

/**
 * 添加 AI 内容（用于纯模拟生成：根据流程环节生成文案并写入列表）
 * @param {string} text - 内容正文
 * @param {string} side - 方向：left(正方) | right(反方)
 * @param {string|null} streamId - 辩题/流ID（与选择辩题对应）
 * @param {string|null} debateId - 辩题ID（可选）
 * @returns {Promise<Object|null>} 返回 { success, data: { id, ... } }
 */
async function addAIContent(text, side, streamId = null, debateId = null) {
	return await apiRequest('/api/admin/ai-content', {
		method: 'POST',
		body: JSON.stringify({
			text: String(text || '').trim(),
			side: side === 'right' ? 'right' : 'left',
			streamId: streamId || null,
			debate_id: debateId || undefined
		})
	});
}

/**
 * 通知大屏显示 AI 内容（纯模拟生成后调用，大屏会展示该辩题的 AI 内容）
 * @param {string} streamId - 辩题/流ID
 * @returns {Promise<Object|null>}
 */
async function notifyAIContentDisplay(streamId) {
	if (!streamId) return null;
	return await apiRequest('/api/admin/ai-content/notify-display', {
		method: 'POST',
		body: JSON.stringify({ streamId })
	});
}

/**
 * 为所有辩题批量生成 AI 内容（纯模拟）
 * @returns {Promise<Object>} { success, message, generated: { [streamId]: { name, count } } }
 */
async function generateAIContentForAllStreams() {
	return await apiRequest('/api/admin/ai-content/generate-all', {
		method: 'POST'
	});
}

// ==================== 数据查询接口 ====================

/**
 * 获取数据概览
 * @param {string|null} streamId - 直播流ID（可选，如果提供则查询该流，否则尝试获取默认流）
 * @returns {Promise<Object|null>}
 */
async function fetchDashboard(streamId = null) {
	// 🔧 修复：后端现在要求必须传递 stream_id 参数
	// 如果没有提供 streamId，尝试获取第一个可用的流ID
	if (!streamId) {
		try {
			// 尝试从流选择器获取
			const streamSelect = document.getElementById('stream-select');
			if (streamSelect && streamSelect.value) {
				streamId = streamSelect.value;
				console.log(`📊 [fetchDashboard] 从流选择器获取 streamId: ${streamId}`);
			}
		} catch (error) {
			console.warn('⚠️ [fetchDashboard] 无法从流选择器获取 streamId:', error);
		}
		
		// 如果还是没有，尝试从流列表获取
		if (!streamId && window.liveSetupStreams && window.liveSetupStreams.length > 0) {
			const activeStream = window.liveSetupStreams.find(s => s.enabled === true);
			if (activeStream) {
				streamId = activeStream.id;
				console.log(`📊 [fetchDashboard] 使用启用的流: ${streamId}`);
			} else {
				streamId = window.liveSetupStreams[0].id;
				console.log(`📊 [fetchDashboard] 使用第一个流: ${streamId}`);
			}
		}
		
		// 如果还是没有，尝试从API获取流列表
		if (!streamId) {
			try {
				const streamsResult = await getStreamsList();
				const streams = streamsResult?.streams || streamsResult?.data || (Array.isArray(streamsResult) ? streamsResult : []);
				if (streams && streams.length > 0) {
					const activeStream = streams.find(s => s.enabled === true);
					streamId = activeStream ? activeStream.id : streams[0].id;
					console.log(`📊 [fetchDashboard] 从API获取流列表，使用流: ${streamId}`);
				}
			} catch (error) {
				console.error('❌ [fetchDashboard] 获取流列表失败:', error);
			}
		}
	}
	
	// 如果还是没有 streamId，返回错误
	if (!streamId) {
		console.error('❌ [fetchDashboard] 无法获取 streamId，后端要求必须传递 stream_id 参数');
		return {
			success: false,
			message: '无法获取直播流ID，请先在"直播流管理"中添加直播流'
		};
	}
	
	// 🔧 修复：使用带 stream_id 参数的 API
	return await apiRequest(`/api/v1/admin/dashboard?stream_id=${streamId}`, {
		method: 'GET'
	});
}

/**
 * 获取用户列表
 * @param {number} page - 页码（从1开始）
 * @param {number} pageSize - 每页数量
 * @param {Object} filters - 过滤条件
 * @returns {Promise<Object|null>}
 */
async function fetchUserList(page = 1, pageSize = 50, filters = {}) {
	// 优先使用本地用户 API（含开播后注入的 mock 用户）
	const res = await apiRequest(`/api/v1/admin/users?page=${page}&pageSize=${pageSize}`, {
		method: 'GET'
	});
	if (res && (res.users || (res.data && res.data.users))) {
		return { users: res.users || res.data.users, total: res.total != null ? res.total : (res.data && res.data.users ? res.data.users.length : 0) };
	}
	const queryParams = new URLSearchParams({ page, pageSize, ...filters });
	return await apiRequest(`/api/admin/miniprogram/users?${queryParams}`, {
		method: 'GET'
	});
}

/**
 * 获取投票统计
 * @param {string} timeRange - 时间范围：'1h'|'6h'|'12h'|'24h'|'7d'
 * @returns {Promise<Object|null>}
 */
async function fetchVotesStatistics(timeRange = '1h') {
	return await apiRequest(`/api/admin/votes/statistics?timeRange=${timeRange}`, {
		method: 'GET'
	});
}

/**
 * 按日期范围获取历史统计（数据统计页「日期查询」）
 * @param {string} from - 起始日期 YYYY-MM-DD
 * @param {string} to - 结束日期 YYYY-MM-DD
 * @returns {Promise<Object|null>} { totalVotes, leftVotes, rightVotes, activeUsers, dailyStats, from, to }
 */
async function fetchStatisticsRange(from, to) {
	const q = new URLSearchParams();
	if (from) q.append('from', from);
	if (to) q.append('to', to);
	return await apiRequest(`/api/admin/statistics/range?${q}`, { method: 'GET' });
}

/**
 * 获取指定日期的活跃用户数（当日投票次数 > 8 视为活跃）
 * @param {string} date - 日期 YYYY-MM-DD
 * @returns {Promise<Object|null>} { activeUsers, date }
 */
async function fetchStatisticsActiveUsers(date) {
	const q = new URLSearchParams();
	if (date) q.append('date', date);
	return await apiRequest(`/api/admin/statistics/active-users?${q}`, { method: 'GET' });
}

/**
 * 获取AI内容列表
 * @param {number} page - 页码（从1开始）
 * @param {number} pageSize - 每页数量
 * @param {string|null} startTime - 开始时间（可选，ISO格式：2024-01-01T00:00:00）
 * @param {string|null} endTime - 结束时间（可选，ISO格式：2024-01-01T23:59:59）
 * @returns {Promise<Object|null>}
 */
async function fetchAIContentList(page = 1, pageSize = 20, startTime = null, endTime = null, streamId = null) {
	const queryParams = new URLSearchParams({
		page: page.toString(),
		pageSize: pageSize.toString()
	});
	
	if (startTime) queryParams.append('startTime', startTime);
	if (endTime) queryParams.append('endTime', endTime);
	
	// 如果提供了streamId，添加到查询参数中
	if (streamId) {
		queryParams.append('stream_id', streamId);
	}
	
	// 使用新的API路径 /api/v1/admin/ai-content/list
	return await apiRequest(`/api/v1/admin/ai-content/list?${queryParams}`, {
		method: 'GET'
	});
}

/**
 * 获取AI内容评论列表
 * @param {string} contentId - AI内容ID
 * @param {number} page - 页码（从1开始）
 * @param {number} pageSize - 每页数量
 * @returns {Promise<Object|null>} 返回 { contentId, contentText, total, page, pageSize, comments }
 */
async function fetchAIContentComments(contentId, page = 1, pageSize = 20) {
	const queryParams = new URLSearchParams({
		page: page.toString(),
		pageSize: pageSize.toString()
	});
	
	// 使用新的API路径 /api/v1/admin/ai-content/{content_id}/comments
	return await apiRequest(`/api/v1/admin/ai-content/${contentId}/comments?${queryParams}`, {
		method: 'GET'
	});
}

/**
 * 删除AI内容评论
 * @param {string} contentId - AI内容ID
 * @param {string} commentId - 评论ID
 * @param {string} reason - 删除原因
 * @param {boolean} notifyUsers - 是否通知用户
 * @returns {Promise<Object|null>}
 */
async function deleteAIContentComment(contentId, commentId, reason = '', notifyUsers = true) {
	// 使用新的API路径 /api/v1/admin/ai-content/{content_id}/comments/{comment_id}
	return await apiRequest(`/api/v1/admin/ai-content/${contentId}/comments/${commentId}`, {
		method: 'DELETE',
		body: JSON.stringify({
			reason,
			notifyUsers
		})
	});
}

// ==================== 直播流管理接口 ====================

/**
 * 获取直播流列表
 * @returns {Promise<Array|null>}
 */
async function getStreamsList() {
	return await apiRequest('/api/v1/admin/streams', {
		method: 'GET'
	});
}

// ==================== 观看人数管理接口 ====================

/**
 * 获取指定直播流的观看人数
 * @param {string} streamId - 直播流ID
 * @returns {Promise<Object|null>} 返回 { streamId, viewers, timestamp }
 */
async function getViewersCount(streamId) {
	if (!streamId) {
		console.warn('⚠️ getViewersCount: streamId 为空');
		return null;
	}
	
	console.log(`📡 [getViewersCount] 查询流 ${streamId} 的观看人数...`);
	
	const result = await apiRequest(`/api/v1/admin/live/viewers?stream_id=${streamId}`, {
		method: 'GET'
	});
	
	console.log(`👥 [getViewersCount] 流 ${streamId} 的观看人数:`, result?.data?.viewers || 0);
	
	return result;
}

/**
 * 获取所有直播流的观看人数
 * @returns {Promise<Object|null>} 返回 { streams, totalConnections, timestamp }
 */
async function getAllViewersCount() {
	console.log('📡 [getAllViewersCount] 查询所有流的观看人数...');
	
	const result = await apiRequest('/api/v1/admin/live/viewers', {
		method: 'GET'
	});
	
	if (result?.data?.streams) {
		const total = Object.values(result.data.streams).reduce((sum, count) => sum + count, 0);
		console.log(`👥 [getAllViewersCount] 总观看人数: ${total}`, result.data.streams);
	}
	
	return result;
}

/**
 * 手动广播指定直播流的观看人数
 * @param {string} streamId - 直播流ID
 * @returns {Promise<Object|null>} 返回 { streamId, viewers, message }
 */
async function broadcastViewersCount(streamId) {
	if (!streamId) {
		console.warn('⚠️ broadcastViewersCount: streamId 为空');
		return null;
	}
	
	console.log(`📡 [broadcastViewersCount] 广播流 ${streamId} 的观看人数...`);
	
	const result = await apiRequest('/api/v1/admin/live/broadcast-viewers', {
		method: 'POST',
		body: JSON.stringify({ streamId })
	});
	
	console.log(`✅ [broadcastViewersCount] 广播成功:`, result?.data);
	
	return result;
}

/**
 * 添加直播流
 * @param {Object} streamData - 直播流数据
 * @returns {Promise<Object|null>}
 */
async function addStream(streamData) {
	return await apiRequest('/api/v1/admin/streams', {
		method: 'POST',
		body: JSON.stringify(streamData)
	});
}

/**
 * 更新直播流
 * @param {string} streamId - 直播流ID
 * @param {Object} streamData - 直播流数据
 * @returns {Promise<Object|null>}
 */
async function updateStream(streamId, streamData) {
	return await apiRequest(`/api/v1/admin/streams/${streamId}`, {
		method: 'PUT',
		body: JSON.stringify(streamData)
	});
}

/**
 * 删除直播流
 * @param {string} streamId - 直播流ID
 * @returns {Promise<Object|null>}
 */
async function deleteStream(streamId) {
	return await apiRequest(`/api/v1/admin/streams/${streamId}`, {
		method: 'DELETE'
	});
}

/**
 * 切换直播流启用状态
 * @param {string} streamId - 直播流ID
 * @returns {Promise<Object|null>}
 */
async function toggleStream(streamId) {
	return await apiRequest(`/api/v1/admin/streams/${streamId}/toggle`, {
		method: 'POST'
	});
}

/**
 * 获取直播流列表并规范为数组（供各页选择器使用）
 * @returns {Promise<Array>} 直播流数组
 */
async function getStreamsListNormalized() {
	const result = await getStreamsList();
	if (Array.isArray(result)) return result;
	if (result?.data?.streams) return result.data.streams;
	if (result?.streams) return result.streams;
	if (result?.data && Array.isArray(result.data)) return result.data;
	return result?.items || result?.list || [];
}

// ==================== 直播流辩题管理接口 ====================

/**
 * 获取流关联的辩题
 * @param {string} streamId - 直播流ID
 * @returns {Promise<Object|null>} 返回 {success: true, data: {...}} 或 {success: true, data: null}
 */
async function getStreamDebateTopic(streamId) {
	return await apiRequest(`/api/v1/admin/streams/${streamId}/debate`, {
		method: 'GET'
	});
}

/**
 * 更新辩题信息
 * @param {string} debateId - 辩题ID
 * @param {Object} debateData - 辩题数据 {title, description, leftPosition, rightPosition, isActive}
 * @returns {Promise<Object|null>}
 */
async function updateDebate(debateId, debateData) {
	return await apiRequest(`/api/v1/admin/debates/${debateId}`, {
		method: 'PUT',
		body: JSON.stringify(debateData)
	});
}

/**
 * 创建新辩题
 * @param {Object} debateData - 辩题数据 {title, description, leftPosition, rightPosition, isActive}
 * @returns {Promise<Object|null>}
 */
async function createDebate(debateData) {
	return await apiRequest(`/api/v1/admin/debates`, {
		method: 'POST',
		body: JSON.stringify(debateData)
	});
}

/**
 * 获取单个辩题详情
 * @param {string} debateId - 辩题ID
 * @returns {Promise<Object|null>}
 */
async function getDebateById(debateId) {
	return await apiRequest(`/api/v1/admin/debates/${debateId}`, {
		method: 'GET'
	});
}

/**
 * 关联辩题到直播流
 * @param {string} streamId - 直播流ID
 * @param {string} debateId - 辩题ID
 * @returns {Promise<Object|null>}
 */
async function associateDebateToStream(streamId, debateId) {
	return await apiRequest(`/api/v1/admin/streams/${streamId}/debate`, {
		method: 'PUT',
		body: JSON.stringify({ debate_id: debateId })
	});
}

/**
 * 删除辩题（通过流ID，解除关联）
 * @param {string} streamId - 直播流ID
 * @returns {Promise<Object|null>}
 */
async function deleteStreamDebateTopic(streamId) {
	return await apiRequest(`/api/v1/admin/streams/${streamId}/debate`, {
		method: 'DELETE'
	});
}

/**
 * 保存辩题到本地（列表修改后立即可见）
 * @param {string} streamId - 直播流ID
 * @param {Object} debateData - { title, description, leftPosition, rightPosition, isActive }
 */
async function saveStreamDebateLocal(streamId, debateData) {
	return await apiRequest(`/api/v1/admin/streams/${streamId}/debate`, {
		method: 'PUT',
		body: JSON.stringify(debateData)
	});
}

/**
 * 开播后注入 mock 用户（50 个，头像默认 wode.png）
 */
async function seedMockUsers() {
	return await apiRequest('/api/v1/admin/live/seed-mock-users', {
		method: 'POST'
	});
}

/**
 * 同步 Mock 直播状态（数据概览页开始/停止直播时调用，用于评委在线等）
 */
async function syncMockLiveState(streamIds) {
	return await apiRequest('/api/v1/admin/sync-mock-live-state', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ streamIds: streamIds || [] })
	});
}

/**
 * Mock 记录单次投票（用于用户历史投票次数、详情）
 */
async function mockRecordVote(streamId, userId, side) {
	return await apiRequest('/api/v1/admin/mock-record-vote', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ streamId, userId, side })
	});
}

// ==================== 辅助功能 ====================

// 全局状态（用于UI显示）- 如果admin.js已经声明，则使用已有的
// 如果还没有声明，则创建一个简单的版本（admin.js加载后会覆盖）
if (typeof window.globalState === 'undefined') {
	window.globalState = {
		isLive: false,
		aiStatus: 'stopped'
	};
}

// WebSocket 消息处理（与 admin.js 集成）
if (window.ws) {
	// 监听WebSocket消息更新全局状态
	const originalOnMessage = window.ws.onmessage;
	window.ws.onmessage = (event) => {
		try {
			const data = JSON.parse(event.data);
			
			// 更新全局状态
			if (data.type === 'liveStatus' && window.globalState) {
				window.globalState.isLive = data.data.isLive;
			}
			
		if (data.type === 'aiStatus' && window.globalState) {
			// 🔧 修复：只更新匹配的流
			const messageStreamId = data.data.streamId;
			const currentStreamId = document.getElementById('ai-stream-select')?.value;
			
			console.log('📨 [admin-api.js] 收到 aiStatus 消息:', { messageStreamId, currentStreamId });
			
			// 只有当消息的 streamId 与当前选中的流匹配时，才更新按钮
			if (!currentStreamId || messageStreamId === currentStreamId) {
				window.globalState.aiStatus = data.data.status;
				// 更新UI按钮状态
				if (typeof updateAIControlButtons === 'function') {
					updateAIControlButtons(data.data.status);
				}
			} else {
				console.log('⚠️ [admin-api.js] aiStatus 消息被忽略（streamId 不匹配）');
			}
		}
			
			if (data.type === 'votesUpdate') {
				// 更新票数显示
				if (typeof updateVotesDisplay === 'function') {
					updateVotesDisplay(data.data);
				}
			}
			
			// 调用原始处理器
			if (originalOnMessage) {
				originalOnMessage.call(window.ws, event);
			}
		} catch (error) {
			console.error('WebSocket 消息处理错误:', error);
		}
	};
}

// ==================== 辩论流程管理API ====================

/**
 * 获取指定流的辩论流程配置
 * @param {string} streamId - 直播流ID
 * @returns {Promise<Object>}
 */
async function getDebateFlowConfig(streamId) {
	try {
		console.log(`📡 获取流 ${streamId} 的辩论流程配置...`);
		
		const result = await apiRequest(`/api/admin/debate-flow?stream_id=${streamId}`, {
			method: 'GET'
		});
		
		console.log(`✅ 获取成功:`, result);
		return result || { segments: [] };
	} catch (error) {
		console.error('❌ 获取辩论流程配置失败:', error);
		// 返回默认流程配置
		return {
			segments: [
				{ name: '正方发言', duration: 180, side: 'left' },
				{ name: '反方质问', duration: 120, side: 'right' },
				{ name: '反方发言', duration: 180, side: 'right' },
				{ name: '正方质问', duration: 120, side: 'left' },
				{ name: '自由辩论', duration: 300, side: 'both' },
				{ name: '正方总结', duration: 120, side: 'left' },
				{ name: '反方总结', duration: 120, side: 'right' }
			]
		};
	}
}

/**
 * 保存辩论流程配置
 * @param {string} streamId - 直播流ID
 * @param {Array} segments - 环节数组
 * @returns {Promise<Object>}
 */
async function saveDebateFlowConfigAPI(streamId, segments) {
	try {
		console.log(`📡 保存流 ${streamId} 的辩论流程配置...`);
		
		const result = await apiRequest(`/api/admin/debate-flow`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				stream_id: streamId,
				segments: segments
			})
		});
		
		console.log(`✅ 保存成功:`, result);
		return result;
	} catch (error) {
		console.error('❌ 保存辩论流程配置失败:', error);
		throw error;
	}
}

/**
 * 发送辩论流程控制命令
 * @param {string} streamId - 直播流ID
 * @param {string} action - 命令 (start/pause/resume/reset/next/prev)
 * @returns {Promise<Object>}
 */
async function sendDebateFlowControl(streamId, action) {
	try {
		console.log(`📡 发送流 ${streamId} 的流程控制命令: ${action}...`);
		
		const result = await apiRequest(`/api/admin/debate-flow/control`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				stream_id: streamId,
				action: action
			})
		});
		
		console.log(`✅ 命令发送成功:`, result);
		return result;
	} catch (error) {
		console.error('❌ 发送流程控制命令失败:', error);
		throw error;
	}
}

console.log('✅ 后台管理系统API模块加载完成');
console.log('📡 当前API服务器:', getAPIBase());

