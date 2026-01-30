/**
 * 评委管理模块
 * 使用 window 挂载共享状态，避免异步/事件中 ReferenceError（未初始化）
 */
(function() {
	'use strict';
	window.__judgesCurrentJudgeIndex = null;
	window.__judgesCurrentStreamId = null;
	window.__judgesData = [
		{ id: 'judge-1', name: '评委1', role: '主评委', avatar: '/admin/assets/images/judges/osmanthus.jpg', votes: 10, userId: null },
		{ id: 'judge-2', name: '评委2', role: '嘉宾评委', avatar: '/admin/assets/images/judges/osmanthus.jpg', votes: 10, userId: null },
		{ id: 'judge-3', name: '评委3', role: '嘉宾评委', avatar: '/admin/assets/images/judges/osmanthus.jpg', votes: 10, userId: null }
	];
	window.__judgesCachedUsers = [];
	window.__judgesMockUsersFallback = (function() {
		var list = [
			{ id: 'judge-user-1', nickName: '评委1', avatarUrl: '/admin/assets/images/judges/osmanthus.jpg' },
			{ id: 'judge-user-2', nickName: '评委2', avatarUrl: '/admin/assets/images/judges/osmanthus.jpg' },
			{ id: 'judge-user-3', nickName: '评委3', avatarUrl: '/admin/assets/images/judges/osmanthus.jpg' }
		];
		for (var i = 1; i <= 35; i++) {
			list.push({ id: 'mock-audience-' + i, nickName: '观众' + i, avatarUrl: '/static/iconfont/wode.png' });
		}
		return list;
	})();
})();

/**
 * 初始化评委管理模块
 */
function initJudgesManagement() {
	console.log('🎯 初始化评委管理模块');

	// 延后加载，确保全局变量已初始化，避免 ReferenceError
	setTimeout(() => {
		loadStreamsForJudges();
	}, 0);

	// 绑定直播流选择事件
	const streamSelect = document.getElementById('judges-stream-select');
	if (streamSelect) {
		streamSelect.addEventListener('change', handleStreamChange);
	}

	// 刷新直播流列表按钮
	const refreshBtn = document.getElementById('judges-refresh-streams-btn');
	if (refreshBtn) {
		refreshBtn.addEventListener('click', loadStreamsForJudges);
	}

	// 刷新用户列表按钮
	const refreshUsersBtn = document.getElementById('judges-refresh-users-btn');
	if (refreshUsersBtn) {
		refreshUsersBtn.addEventListener('click', async () => {
			await populateAllJudgeUserSelects();
			showNotification('用户列表已刷新', 'success');
		});
	}

	// 绑定所有上传头像按钮
	document.querySelectorAll('.upload-avatar-btn').forEach((btn, index) => {
		btn.addEventListener('click', () => {
			const card = btn.closest('.judge-edit-card');
			const fileInput = card.querySelector('.judge-avatar-upload');
			fileInput.click();
		});
	});

	// 绑定文件输入变化事件
	document.querySelectorAll('.judge-avatar-upload').forEach((input, index) => {
		input.addEventListener('change', (e) => handleAvatarUpload(e, index));
	});

	// 绑定"从用户选择"下拉框（点击/聚焦时重新拉取用户列表）
	document.querySelectorAll('.judge-user-select').forEach((sel) => {
		sel.addEventListener('focus', async () => {
			await fetchAndCacheUsers();
			populateJudgeUserSelect(sel);
		});
		sel.addEventListener('click', async () => {
			await fetchAndCacheUsers();
			populateJudgeUserSelect(sel);
		});
		sel.addEventListener('change', (e) => handleJudgeUserSelectChange(e, sel));
	});

	// 绑定头像预览hover效果
	document.querySelectorAll('.judge-avatar-preview').forEach((preview, index) => {
		const overlay = preview.querySelector('.avatar-overlay');
		preview.addEventListener('mouseenter', () => {
			overlay.style.display = 'flex';
		});
		preview.addEventListener('mouseleave', () => {
			overlay.style.display = 'none';
		});
		preview.addEventListener('click', () => {
			const card = preview.closest('.judge-edit-card');
			const fileInput = card.querySelector('.judge-avatar-upload');
			if (fileInput) fileInput.click();
		});
	});

	// 绑定保存按钮
	const saveBtn = document.getElementById('save-judges-btn');
	if (saveBtn) {
		saveBtn.addEventListener('click', saveJudgesData);
	}

	// 延后加载用户列表
	setTimeout(() => {
		populateAllJudgeUserSelects();
	}, 0);

	// 监听直播流列表更新（添加/编辑/删除流后，刷新评委页的流选择器）
	window.addEventListener('streams-list-updated', () => {
		loadStreamsForJudges();
	});

	console.log('✅ 评委管理模块初始化完成');
}

/**
 * 加载直播流列表
 */
async function loadStreamsForJudges() {
	try {
		const raw = typeof getStreamsListNormalized === 'function'
			? await getStreamsListNormalized()
			: (await getStreamsList())?.streams || (await getStreamsList())?.data?.streams || [];
		const streams = Array.isArray(raw) ? raw : [];
		const select = document.getElementById('judges-stream-select');

		if (!select) return;

		const currentValue = select.value;
		select.innerHTML = '<option value="">请选择要管理的直播流</option>';

		streams.forEach(stream => {
			if (stream.enabled !== false) {
				const option = document.createElement('option');
				option.value = stream.id;
				option.textContent = `${stream.name || '未命名'} (${(stream.type || 'hls').toUpperCase()})`;
				select.appendChild(option);
			}
		});

		if (currentValue && Array.from(select.options).some(o => o.value === currentValue)) {
			select.value = currentValue;
			window.__judgesCurrentStreamId = currentValue;
			await loadJudgesDataForStream(currentValue);
		} else if (streams.length > 0 && !currentValue) {
			// 若只有一个流且未选择，自动选中并加载评委
			const firstEnabled = streams.find(s => s.enabled !== false);
			if (firstEnabled) {
				select.value = firstEnabled.id;
				window.__judgesCurrentStreamId = firstEnabled.id;
				await loadJudgesDataForStream(firstEnabled.id);
			}
		}

		console.log('✅ 评委管理流列表已加载');
	} catch (error) {
		console.error('❌ 加载直播流列表失败:', error);
		showNotification('加载直播流列表失败', 'error');
	}
}

/**
 * 处理直播流选择变化
 */
function handleStreamChange(e) {
	const streamId = e.target.value;
	window.__judgesCurrentStreamId = streamId;

	const select = e.target;
	const selectedOption = select.options[select.selectedIndex];
	const streamName = selectedOption ? selectedOption.textContent : '-';

	// 显示当前管理的流信息
	const infoDiv = document.getElementById('judges-current-stream-info');
	const nameSpan = document.getElementById('judges-current-stream-name');

	if (streamId && infoDiv && nameSpan) {
		nameSpan.textContent = streamName;
		infoDiv.style.display = 'block';
	} else if (infoDiv) {
		infoDiv.style.display = 'none';
	}

	// 加载该流的评委数据
	if (streamId) {
		loadJudgesDataForStream(streamId);
	}
}

/**
 * 加载指定直播流的评委数据（使用完整 URL，避免网络错误）
 */
async function loadJudgesDataForStream(streamId) {
	if (!streamId) return;
	try {
		const base = (window.SERVER_CONFIG?.BASE_URL || window.location?.origin || '') + '/api/admin/judges';
		const url = `${base}?stream_id=${encodeURIComponent(streamId)}`;
		const response = await fetch(url);
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const result = await response.json();
		if (result?.success && result?.data?.judges) {
			const list = Array.isArray(result.data.judges) ? result.data.judges : [];
			window.__judgesData = list.length > 0 ? list.map((j, i) => ({
				id: j.id || 'judge-' + (i + 1),
				name: j.name || '评委' + (i + 1),
				role: j.role || '评委',
				avatar: j.avatar || '/admin/assets/images/judges/osmanthus.jpg',
				votes: j.votes != null ? j.votes : 10,
				userId: j.userId || null
			})) : window.__judgesData;
		}
		updateJudgesUI();
		populateAllJudgeUserSelects();
	} catch (error) {
		console.error('❌ 加载评委数据失败:', error);
		showNotification('加载评委数据失败，请检查网络或刷新重试', 'error');
		updateJudgesUI();
		populateAllJudgeUserSelects();
	}
}

/**
 * 更新评委UI显示
 */
function updateJudgesUI() {
	var data = window.__judgesData || [];
	document.querySelectorAll('.judge-edit-card').forEach((card, index) => {
		if (data[index]) {
			const judge = data[index];
			const nameInput = card.querySelector('.judge-name-input');
			const roleInput = card.querySelector('.judge-role-input');
			const votesInput = card.querySelector('.judge-votes-input');
			const avatarImg = card.querySelector('.judge-avatar-img');
			const userSelect = card.querySelector('.judge-user-select');

			if (nameInput) nameInput.value = judge.name;
			if (roleInput) roleInput.value = judge.role;
			if (votesInput) votesInput.value = judge.votes || 0;
			if (avatarImg && judge.avatar) {
				avatarImg.src = toAbsoluteAvatarUrl(judge.avatar);
			}
			if (userSelect && judge.userId) {
				userSelect.value = judge.userId;
			}
		}
	});
}

function toAbsoluteAvatarUrl(url) {
	if (!url) return '/static/iconfont/wode.png';
	if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:')) return url;
	if (url.startsWith('/')) return (window.location.origin || '') + url;
	return (window.location.origin || '') + (window.location.pathname.startsWith('/admin') ? '' : '/admin') + (url.startsWith('/') ? url : '/' + url);
}

/**
 * 处理头像上传（上传到服务器并保存）
 */
async function handleAvatarUpload(event, judgeIndex) {
	const file = event.target.files[0];
	if (!file) return;

	// 验证文件类型
	if (!file.type.startsWith('image/')) {
		showNotification('请选择图片文件', 'error');
		return;
	}

	// 验证文件大小 (最大2MB)
	if (file.size > 2 * 1024 * 1024) {
		showNotification('图片大小不能超过2MB', 'error');
		return;
	}

	const reader = new FileReader();
	reader.onload = async (e) => {
		const base64 = e.target.result;
		const card = document.querySelectorAll('.judge-edit-card')[judgeIndex];
		try {
			const base = window.SERVER_CONFIG?.BASE_URL || window.location?.origin || '';
		const response = await fetch(base + '/api/admin/upload/avatar', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ base64 })
			});
			const result = await response.json();
			if (result.success && result.url) {
				const avatarImg = card.querySelector('.judge-avatar-img');
				if (avatarImg) avatarImg.src = toAbsoluteAvatarUrl(result.url);
				if (window.__judgesData[judgeIndex]) window.__judgesData[judgeIndex].avatar = result.url;
				showNotification('头像已更新，请点击「保存评委信息」以保存到服务器', 'success');
			} else {
				const avatarImg = card.querySelector('.judge-avatar-img');
				if (avatarImg) avatarImg.src = base64;
				if (window.__judgesData[judgeIndex]) window.__judgesData[judgeIndex].avatar = base64;
				showNotification('头像上传失败，已本地预览', 'warning');
			}
		} catch (err) {
			console.error('头像上传失败:', err);
			const avatarImg = card.querySelector('.judge-avatar-img');
			if (avatarImg) avatarImg.src = base64;
			if (window.__judgesData[judgeIndex]) window.__judgesData[judgeIndex].avatar = base64;
			showNotification('头像上传失败，已本地预览', 'warning');
		}
	};
	reader.readAsDataURL(file);
	event.target.value = '';
}

/**
 * 加载用户列表并填充到所有评委下拉框
 */
async function populateAllJudgeUserSelects() {
	await fetchAndCacheUsers();
	document.querySelectorAll('.judge-user-select').forEach(populateJudgeUserSelect);
}

/**
 * 填充单个评委的用户下拉框
 */
function populateJudgeUserSelect(selectEl) {
	if (!selectEl) return;
	const currentValue = selectEl.value;
	const users = window.__judgesCachedUsers || [];
	selectEl.innerHTML = '<option value="">从用户中选择...</option>';
	if (users.length === 0) {
		const opt = document.createElement('option');
		opt.value = '';
		opt.textContent = '暂无用户，请点击「生成 Mock 用户」或刷新重试';
		opt.disabled = true;
		selectEl.appendChild(opt);
	} else {
		users.forEach(user => {
			const n = user.nickName || user.nickname || user.name || '未命名';
			const opt = document.createElement('option');
			opt.value = user.id;
			opt.textContent = n;
			selectEl.appendChild(opt);
		});
	}
	if (currentValue && users.some(u => u.id === currentValue)) {
		selectEl.value = currentValue;
	}
}

/**
 * 拉取并缓存用户列表（使用完整 URL，避免网络错误）
 */
async function fetchAndCacheUsers() {
	const base = window.SERVER_CONFIG?.BASE_URL || window.location?.origin || '';
	const urls = [
		base + '/api/admin/users/for-judge-select',
		base + '/api/admin/users',
		base + '/api/v1/admin/users'
	];
	for (const url of urls) {
		try {
			const response = await fetch(url);
			if (!response.ok) continue;
			const result = await response.json();
			// 兼容多种返回格式：{ data: { users: [] } } | { users: [] } | 直接数组
			let list = result?.data?.users || result?.users;
			if (!Array.isArray(list) && Array.isArray(result)) list = result;
			if (Array.isArray(list) && list.length > 0) {
				window.__judgesCachedUsers = list;
				console.log('✅ 用户列表加载成功，共', list.length, '人');
				return window.__judgesCachedUsers;
			}
		} catch (e) {
			continue;
		}
	}
	// API 失败时使用内置 38 个 mock 用户，确保下拉框始终有选项可选
	console.warn('⚠️ 用户列表 API 加载失败，使用内置 38 个 mock 用户');
	window.__judgesCachedUsers = window.__judgesMockUsersFallback;
	return window.__judgesCachedUsers;
}

/**
 * 用户下拉框选择变化
 */
function handleJudgeUserSelectChange(e, selectEl) {
	const userId = selectEl.value;
	if (!userId) return;
	const judgeIndex = parseInt(selectEl.dataset.judgeIndex, 10);
	const user = (window.__judgesCachedUsers || []).find(u => u.id === userId);
	if (user) {
		selectUserAsJudge(user, judgeIndex);
	}
}

/**
 * 选择用户作为评委（评委被选用时可看直播、可投票；被替换后才不能看直播、不能投票）
 */
function selectUserAsJudge(user, judgeIndex) {
	const idx = judgeIndex !== undefined ? judgeIndex : window.__judgesCurrentJudgeIndex;
	if (idx === null || idx === undefined) return;

	const card = document.querySelectorAll('.judge-edit-card')[idx];
	if (!card) return;

	const nickname = user.nickName || user.nickname || user.name || ('评委' + (idx + 1));
	const avatarUrl = user.avatarUrl || user.avatar || '/admin/assets/images/judges/osmanthus.jpg';

	// 记录被替换的评委（若原评委来自用户，保存时传给后端；后端会将被替换的普通用户设为 banned）
	const data = window.__judgesData || [];
	const prevJudge = data[idx];
	const prevUserId = prevJudge && prevJudge.userId ? prevJudge.userId : null;

	// 更新姓名
	const nameInput = card.querySelector('.judge-name-input');
	if (nameInput) nameInput.value = nickname;

	// 更新头像（使用 img 标签，与用户管理一致）
	const avatarImg = card.querySelector('.judge-avatar-img');
	if (avatarImg && avatarUrl) avatarImg.src = toAbsoluteAvatarUrl(avatarUrl);

	// 更新数据（userId 用于保存时传给后端，若替换则禁用原用户）
	if (window.__judgesData[idx]) {
		window.__judgesData[idx].name = nickname;
		window.__judgesData[idx].avatar = avatarUrl;
		window.__judgesData[idx].userId = user.id;
		window.__judgesData[idx]._replacedUserId = prevUserId;
	}

	showNotification(`已选择 ${nickname} 作为评委`, 'success');
}

/**
 * 保存评委数据（未选直播流时提醒，已选则直接保存并展示）
 */
async function saveJudgesData() {
	const streamId = document.getElementById('judges-stream-select')?.value;
	if (!streamId) {
		showNotification('请先选择直播流', 'warning');
		alert('请先选择要管理的直播流');
		return;
	}

	// 收集表单数据
	const cards = document.querySelectorAll('.judge-edit-card');
	const updatedJudges = [];
	const replacedUserIds = [];

	var data = window.__judgesData || [];
	cards.forEach((card, index) => {
		const nameInput = card.querySelector('.judge-name-input');
		const roleInput = card.querySelector('.judge-role-input');
		const votesInput = card.querySelector('.judge-votes-input');
		const prev = data[index];
		if (prev && prev._replacedUserId) {
			replacedUserIds.push(prev._replacedUserId);
		}
		updatedJudges.push({
			id: prev?.id || `judge-${index + 1}`,
			name: nameInput?.value || `评委${index + 1}`,
			role: roleInput?.value || '评委',
			avatar: prev?.avatar || '/admin/assets/images/judges/osmanthus.jpg',
			votes: parseInt(votesInput?.value) || 10,
			userId: prev?.userId || null
		});
	});

	try {
		const base = window.SERVER_CONFIG?.BASE_URL || window.location?.origin || '';
		const response = await fetch(base + '/api/admin/judges', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				stream_id: streamId,
				judges: updatedJudges,
				replaced_user_ids: [...new Set(replacedUserIds)]
			})
		});
		const result = await response.json();

		if (result.success) {
			window.__judgesData = updatedJudges.map(function(j) { var o = Object.assign({}, j); o._replacedUserId = undefined; return o; });
			showNotification('评委信息保存成功', 'success');
			notifyVoteDisplayUpdate();
			// 重新加载并展示
			await loadJudgesDataForStream(streamId);
		} else {
			showNotification(result.error || '保存失败', 'error');
		}
	} catch (error) {
		console.error('❌ 保存评委数据失败:', error);
		showNotification('保存失败，请重试', 'error');
	}
}

/**
 * 通知大屏幕更新评委信息（后端已广播 judges-updated，大屏通过 WebSocket 接收）
 */
function notifyVoteDisplayUpdate() {
	console.log('📢 评委信息已保存，大屏幕将自动同步');
}

/**
 * 显示通知消息（优先使用页面 Toast，避免阻塞）
 */
function showNotification(message, type = 'info') {
	console.log(`📢 [${type.toUpperCase()}] ${message}`);
	if (typeof showToast === 'function') {
		showToast(message, type === 'warning' ? 'warning' : type === 'error' ? 'error' : type === 'success' ? 'success' : 'info');
	} else {
		alert(message);
	}
}

/**
 * 获取API基础地址
 */
function getAPIBase() {
	if (window.SERVER_CONFIG && window.SERVER_CONFIG.BASE_URL) {
		return window.SERVER_CONFIG.BASE_URL;
	}
	if (typeof window !== 'undefined' && window.location && window.location.origin) return window.location.origin;
	return 'http://localhost:8080';
}

// 导出函数供外部使用
if (typeof window !== 'undefined') {
	window.initJudgesManagement = initJudgesManagement;
	window.judgesData = window.__judgesData || [];
}
