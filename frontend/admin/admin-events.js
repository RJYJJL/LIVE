// 后台管理系统事件处理器
// 本文件包含所有新功能的按钮事件绑定

// 页面加载完成后绑定事件
document.addEventListener('DOMContentLoaded', () => {
	console.log('🎯 初始化后台管理系统事件处理器...');
	initVotesEvents();
	initAIEvents();
	initLiveControlEvents();
	initDebateFlowEvents();
	
	// 监听直播流列表更新（添加/编辑/删除流后，刷新票数、AI、辩论流程等页的流选择器）
	window.addEventListener('streams-list-updated', () => {
		if (typeof loadVotesStreamsList === 'function') loadVotesStreamsList();
		if (typeof loadAIStreamsList === 'function') loadAIStreamsList();
		if (typeof loadDebateFlowStreamsList === 'function') loadDebateFlowStreamsList();
	});
});

// ==================== 票数管理事件 ====================

function initVotesEvents() {
	// 加载流列表到选择器
	loadVotesStreamsList();
	
	// 刷新流列表按钮
	const refreshStreamsBtn = document.getElementById('votes-refresh-streams-btn');
	if (refreshStreamsBtn) {
		refreshStreamsBtn.addEventListener('click', () => {
			loadVotesStreamsList();
		});
	}
	
	// 流选择变化时，加载对应流的票数
	const streamSelect = document.getElementById('votes-stream-select');
	if (streamSelect) {
		streamSelect.addEventListener('change', async (e) => {
			const streamId = e.target.value;
			if (streamId) {
				await loadVotesByStream(streamId);
			} else {
				// 清空显示
				clearVotesDisplay();
				hideVotesStreamInfo();
			}
		});
	}
	
	// 功能一：设置票数
	const setVotesBtn = document.getElementById('set-votes-btn');
	if (setVotesBtn) {
		setVotesBtn.addEventListener('click', async () => {
			const streamId = document.getElementById('votes-stream-select')?.value;
			if (!streamId) {
				alert('请先选择要管理的直播流');
				return;
			}
			
			const leftVotes = parseInt(document.getElementById('set-left-votes').value, 10);
			const rightVotes = parseInt(document.getElementById('set-right-votes').value, 10);
			if (isNaN(leftVotes) || isNaN(rightVotes) || leftVotes < 0 || rightVotes < 0) {
				alert('请输入有效的非负整数票数');
				return;
			}
			const reason = document.getElementById('set-votes-reason').value || '手动设置';
			
			if (!confirm(`确定要设置票数为：正方 ${leftVotes}，反方 ${rightVotes} 吗？\n（将覆盖当前该流的票数）`)) {
				return;
			}
			
			const result = await updateVotes('set', leftVotes, rightVotes, reason, true, streamId);
			if (result) {
				const voteData = result.data?.afterUpdate || result.afterUpdate || result.currentVotes || (result.leftVotes !== undefined ? result : null);
				if (voteData) {
					const total = (voteData.leftVotes || 0) + (voteData.rightVotes || 0);
					updateVotesDisplay({
						leftVotes: voteData.leftVotes ?? leftVotes,
						rightVotes: voteData.rightVotes ?? rightVotes,
						totalVotes: voteData.totalVotes ?? total,
						leftPercentage: total > 0 ? Math.round(((voteData.leftVotes || 0) / total) * 100) : 50,
						rightPercentage: total > 0 ? Math.round(((voteData.rightVotes || 0) / total) * 100) : 50
					});
				} else {
					await loadVotesByStream(streamId);
				}
				document.getElementById('set-left-votes').value = '';
				document.getElementById('set-right-votes').value = '';
				document.getElementById('set-votes-reason').value = '';
				if (typeof showToast === 'function') showToast('票数设置成功', 'success'); else alert('票数设置成功');
			}
		});
	}
	
	// 功能二：增加票数
	const addVotesBtn = document.getElementById('add-votes-btn');
	if (addVotesBtn) {
		addVotesBtn.addEventListener('click', async () => {
			const streamId = document.getElementById('votes-stream-select')?.value;
			if (!streamId) {
				alert('请先选择要管理的直播流');
				return;
			}
			
			const leftVotes = parseInt(document.getElementById('add-left-votes').value, 10) || 0;
			const rightVotes = parseInt(document.getElementById('add-right-votes').value, 10) || 0;
			const reason = document.getElementById('add-votes-reason').value || '增加票数';
			
			if (leftVotes === 0 && rightVotes === 0) {
				alert('请输入要增加的票数（至少一方大于 0）');
				return;
			}
			
			if (!confirm(`确定要增加票数：正方 +${leftVotes}，反方 +${rightVotes} 吗？`)) {
				return;
			}
			
			const result = await updateVotes('add', leftVotes, rightVotes, reason, true, streamId);
			if (result) {
				const voteData = result.data?.afterUpdate || result.afterUpdate || result.currentVotes || (result.leftVotes !== undefined ? result : null);
				if (voteData) {
					const total = (voteData.leftVotes || 0) + (voteData.rightVotes || 0);
					updateVotesDisplay({
						leftVotes: voteData.leftVotes,
						rightVotes: voteData.rightVotes,
						totalVotes: voteData.totalVotes ?? total,
						leftPercentage: total > 0 ? Math.round(((voteData.leftVotes || 0) / total) * 100) : 50,
						rightPercentage: total > 0 ? Math.round(((voteData.rightVotes || 0) / total) * 100) : 50
					});
				} else {
					await loadVotesByStream(streamId);
				}
				document.getElementById('add-left-votes').value = '';
				document.getElementById('add-right-votes').value = '';
				document.getElementById('add-votes-reason').value = '';
				if (typeof showToast === 'function') showToast('票数增加成功', 'success'); else alert('票数增加成功');
			}
		});
	}
	
	// 功能三：重置票数（初始值默认0，可修改；含调整原因）
	const resetVotesBtn = document.getElementById('reset-votes-btn');
	if (resetVotesBtn) {
		resetVotesBtn.addEventListener('click', async () => {
			const streamId = document.getElementById('votes-stream-select')?.value;
			if (!streamId) {
				alert('请先选择要管理的直播流');
				return;
			}
			
			const leftVotes = parseInt(document.getElementById('reset-left-votes').value, 10) || 0;
			const rightVotes = parseInt(document.getElementById('reset-right-votes').value, 10) || 0;
			const reason = document.getElementById('reset-votes-reason')?.value || '重置票数';
			
			if (!confirm(`⚠️ 确定要重置票数吗？\n将重置为：正方 ${leftVotes}，反方 ${rightVotes}\n当前数据会被自动备份。`)) {
				return;
			}
			
			const result = await resetVotes(leftVotes, rightVotes, true, true, streamId, reason);
			if (result) {
				const cur = result.data?.currentVotes || result.currentVotes || result;
				const l = cur.leftVotes ?? leftVotes;
				const r = cur.rightVotes ?? rightVotes;
				const total = l + r;
				updateVotesDisplay({
					leftVotes: l,
					rightVotes: r,
					totalVotes: total,
					leftPercentage: total > 0 ? Math.round((l / total) * 100) : 50,
					rightPercentage: total > 0 ? Math.round((r / total) * 100) : 50
				});
				if (typeof showToast === 'function') showToast('票数重置成功', 'success'); else alert('票数重置成功');
			}
		});
	}
}

/**
 * 加载流列表到票数管理选择器
 */
async function loadVotesStreamsList() {
	try {
		const streamSelect = document.getElementById('votes-stream-select');
		if (!streamSelect) return;
		
		const streams = typeof getStreamsListNormalized === 'function'
			? await getStreamsListNormalized()
			: (await getStreamsList())?.streams || (await getStreamsList())?.data?.streams || [];
		
		if (!Array.isArray(streams)) {
			console.warn('⚠️ 无法获取流列表');
			return;
		}
		
		// 保存当前选中的值
		const currentValue = streamSelect.value;
		
		// 清空并重新填充
		streamSelect.innerHTML = '<option value="">请选择要管理的直播流</option>';
		
		streams.forEach(stream => {
			if (stream.enabled !== false) {
				const option = document.createElement('option');
				option.value = stream.id;
				option.textContent = `${stream.name || '未命名'} (${(stream.type || 'hls').toUpperCase()})`;
				streamSelect.appendChild(option);
			}
		});
		
		// 恢复之前选中的值（若仍存在）
		if (currentValue && Array.from(streamSelect.options).some(o => o.value === currentValue)) {
			streamSelect.value = currentValue;
		}
		
		console.log('✅ 票数管理流列表已加载，共', streams.length, '个');
	} catch (error) {
		console.error('❌ 加载票数管理流列表失败:', error);
	}
}

/**
 * 根据流ID加载票数
 */
async function loadVotesByStream(streamId) {
	try {
		const data = await fetchDashboardByStream(streamId);
		if (!data) {
			console.warn('⚠️ 无法获取流票数数据');
			return;
		}
		// 票数管理页始终展示「当前票数」（可手动修改）；大屏用 leftVotes/rightVotes（直播中=本场）
		const leftVotes = (data.currentLeftVotes != null ? data.currentLeftVotes : data.leftVotes) || 0;
		const rightVotes = (data.currentRightVotes != null ? data.currentRightVotes : data.rightVotes) || 0;
		const totalVotes = data.totalVotes || (leftVotes + rightVotes);
		const leftPercentage = data.leftPercentage || (totalVotes > 0 ? Math.round((leftVotes / totalVotes) * 100) : 50);
		const rightPercentage = data.rightPercentage || (totalVotes > 0 ? Math.round((rightVotes / totalVotes) * 100) : 50);
		
		updateVotesDisplay({
			leftVotes,
			rightVotes,
			totalVotes,
			leftPercentage,
			rightPercentage
		});
		
		// 显示当前流信息
		const streams = typeof getStreamsListNormalized === 'function'
			? await getStreamsListNormalized()
			: (await getStreamsList())?.streams || [];
		const stream = Array.isArray(streams) ? streams.find(s => s.id === streamId) : null;
		if (stream) {
			const startTime = data.isLive ? (data.liveStatus?.startTime || stream.liveStatus?.startTime || data.liveStartTime) : null;
			showVotesStreamInfo(stream.name || '未命名', data.isLive ? '🟢 直播中' : '⚪ 未直播', startTime);
		}
		
		console.log(`✅ 已加载流 ${streamId} 的票数数据`);
	} catch (error) {
		console.error('❌ 加载流票数失败:', error);
		showNotification('加载票数失败', 'error');
	}
}

/**
 * 显示当前流信息（含直播测试时间）
 */
function showVotesStreamInfo(streamName, status, startTimeIso) {
	const infoEl = document.getElementById('votes-current-stream-info');
	const nameEl = document.getElementById('votes-current-stream-name');
	const statusEl = document.getElementById('votes-current-stream-status');
	const startTimeWrap = document.getElementById('votes-current-stream-start-time-wrap');
	const startTimeEl = document.getElementById('votes-current-stream-start-time');
	
	if (infoEl) infoEl.style.display = 'block';
	if (nameEl) nameEl.textContent = streamName;
	if (statusEl) statusEl.textContent = status;
	if (startTimeWrap && startTimeEl) {
		if (startTimeIso && status && status.includes('直播中')) {
			startTimeWrap.style.display = 'inline';
			startTimeEl.textContent = typeof formatStreamStartTime === 'function' ? formatStreamStartTime(startTimeIso) : startTimeIso;
		} else {
			startTimeWrap.style.display = 'none';
		}
	}
}

/**
 * 隐藏当前流信息
 */
function hideVotesStreamInfo() {
	const infoEl = document.getElementById('votes-current-stream-info');
	if (infoEl) infoEl.style.display = 'none';
}

/**
 * 清空票数显示
 */
function clearVotesDisplay() {
	updateVotesDisplay({
		leftVotes: 0,
		rightVotes: 0,
		totalVotes: 0,
		leftPercentage: 50,
		rightPercentage: 50
	});
}

// 更新票数显示（票数管理页 + 数据概览页总票数）
function updateVotesDisplay(data) {
	const leftVotes = data.leftVotes || 0;
	const rightVotes = data.rightVotes || 0;
	const total = data.totalVotes ?? (leftVotes + rightVotes);
	const leftPct = data.leftPercentage ?? (total > 0 ? Math.round((leftVotes / total) * 100) : 50);
	const rightPct = data.rightPercentage ?? (total > 0 ? Math.round((rightVotes / total) * 100) : 50);
	
	const leftVotesEl = document.getElementById('admin-left-votes');
	const rightVotesEl = document.getElementById('admin-right-votes');
	const totalVotesEl = document.getElementById('admin-total-votes');
	const percentageEl = document.getElementById('admin-vote-percentage');
	const dashboardTotalEl = document.getElementById('total-votes');
	
	if (leftVotesEl) leftVotesEl.textContent = leftVotes;
	if (rightVotesEl) rightVotesEl.textContent = rightVotes;
	if (totalVotesEl) totalVotesEl.textContent = total;
	if (percentageEl) percentageEl.textContent = `正方: ${leftPct}% | 反方: ${rightPct}%`;
	// 紫色导航栏总投票数：Mock 时只由 updateMockGlobalStats 更新，此处不写避免双数字闪烁
	if (dashboardTotalEl && typeof mockGetGlobalDisplayData !== 'function') {
		const globalTotal = data.globalTotalVotes ?? data.allTotalVotes;
		const cur = parseInt(dashboardTotalEl.textContent, 10) || 0;
		const val = (globalTotal != null && globalTotal >= 0) ? globalTotal : cur;
		if (val > 0 || cur === 0) dashboardTotalEl.textContent = val;
	}
}

// ==================== AI控制事件 ====================

function initAIEvents() {
	// 🔧 新增：加载AI直播流列表
	loadAIStreamsList();
	
	// 🔧 新增：刷新直播流列表按钮
	const aiRefreshStreamsBtn = document.getElementById('ai-refresh-streams-btn');
	if (aiRefreshStreamsBtn) {
		aiRefreshStreamsBtn.addEventListener('click', () => {
			loadAIStreamsList();
		});
	}
	
	// 🔧 新增：流选择变化时，重新加载AI内容列表
	const aiStreamSelect = document.getElementById('ai-stream-select');
	if (aiStreamSelect) {
		aiStreamSelect.addEventListener('change', async (e) => {
			const streamId = e.target.value;
			if (streamId) {
				// 🔧 新增：查询该流的 AI 状态并更新按钮
				console.log(`🔄 切换到流 ${streamId}，查询 AI 状态...`);
				await updateAIStatusForStream(streamId);
				
				// 重新加载AI内容列表
				await loadAIContentList(1);
			} else {
				// 清空显示
				hideAIContentStreamInfo();
				const container = document.getElementById('ai-content-list');
				if (container) {
					container.innerHTML = '<div style="text-align: center; padding: 40px; color: #999;">请先选择辩题，再点击「启动AI识别」根据流程设置生成内容</div>';
				}
				
				// 重置 AI 按钮状态为 stopped
				updateAIControlButtons('stopped');
			}
		});
	}
	
	// 启动AI识别（无直播版：根据当前流程设置纯模拟生成辩论内容）
	window.__aiMockSessionContentIds = window.__aiMockSessionContentIds || [];
	const startAIBtn = document.getElementById('start-ai-btn');
	if (startAIBtn) {
		startAIBtn.addEventListener('click', async () => {
			const originalText = startAIBtn.textContent;
			const aiStreamSelect = document.getElementById('ai-stream-select');
			const streamId = aiStreamSelect?.value?.trim() || null;
			if (!streamId) {
				if (typeof showToast === 'function') showToast('请先选择辩题', 'error');
				else alert('请先选择辩题');
				if (aiStreamSelect) {
					aiStreamSelect.style.border = '2px solid #ff4d4f';
					setTimeout(() => { aiStreamSelect.style.border = ''; }, 2000);
				}
				return;
			}
			try {
				startAIBtn.disabled = true;
				startAIBtn.textContent = '生成中...';
				// 获取该辩题对应的流程配置
				const flowResult = typeof getDebateFlowConfig === 'function' ? await getDebateFlowConfig(streamId) : { segments: [] };
				const segments = flowResult && flowResult.segments && flowResult.segments.length > 0 ? flowResult.segments : [
					{ name: '正方发言', duration: 120, side: 'left' },
					{ name: '反方发言', duration: 120, side: 'right' },
					{ name: '自由辩论', duration: 180, side: 'both' }
				];
				const items = generateMockContentFromSegments(segments);
				const createdIds = [];
				for (const item of items) {
					const res = typeof addAIContent === 'function' ? await addAIContent(item.text, item.side, streamId) : null;
					const id = (res && res.data && res.data.id) ? res.data.id : (res && res.id) ? res.id : null;
					if (id) createdIds.push(id);
				}
				window.__aiMockSessionContentIds = createdIds;
				updateAIControlButtons('running');
				const streamName = aiStreamSelect.options[aiStreamSelect.selectedIndex]?.text || streamId;
				const streamInfoEl = document.getElementById('ai-current-stream-info');
				const streamNameEl = document.getElementById('ai-running-stream-name');
				if (streamInfoEl && streamNameEl) {
					streamNameEl.textContent = streamName;
					streamInfoEl.style.display = 'block';
				}
				if (typeof showToast === 'function') showToast('已根据流程设置生成 ' + items.length + ' 条辩论内容', 'success');
				if (typeof loadAIContentList === 'function') await loadAIContentList(1);
				// 通知大屏显示 AI 内容（大屏会展示该辩题的生成内容）
				if (typeof notifyAIContentDisplay === 'function') {
					notifyAIContentDisplay(streamId).catch(() => {});
				}
			} catch (error) {
				console.error('❌ 生成AI内容失败:', error);
				if (typeof showToast === 'function') showToast('生成失败：' + (error.message || '未知错误'), 'error');
			} finally {
				startAIBtn.disabled = false;
				startAIBtn.textContent = originalText;
			}
		});
	}
	
	// 停止AI识别（无直播版：仅清空本次生成的内容，保留历史记录）
	const stopAIBtn = document.getElementById('stop-ai-btn');
	if (stopAIBtn) {
		stopAIBtn.addEventListener('click', async () => {
			if (!confirm('确定要停止并清空本次生成的内容吗？历史记录会保留。')) return;
			const originalText = stopAIBtn.textContent;
			try {
				stopAIBtn.disabled = true;
				stopAIBtn.textContent = '清空中...';
				const ids = window.__aiMockSessionContentIds || [];
				for (const id of ids) {
					try {
						if (typeof deleteAIContent === 'function') await deleteAIContent(id, '用户停止AI并清空本次生成', false);
					} catch (e) { /* 单条删除失败忽略 */ }
				}
				window.__aiMockSessionContentIds = [];
				updateAIControlButtons('stopped');
				const streamInfoEl = document.getElementById('ai-current-stream-info');
				if (streamInfoEl) streamInfoEl.style.display = 'none';
				if (typeof showToast === 'function') showToast('已清空本次生成的内容，可再次点击「启动AI识别」重新生成', 'success');
				if (typeof loadAIContentList === 'function') await loadAIContentList(1);
			} catch (error) {
				console.error('❌ 清空内容失败:', error);
				if (typeof showToast === 'function') showToast('清空失败：' + (error.message || ''), 'error');
			} finally {
				stopAIBtn.disabled = false;
				stopAIBtn.textContent = originalText;
			}
		});
	}
	
	// 一键为所有辩题生成 AI 内容
	const generateAllAIBtn = document.getElementById('generate-all-ai-btn');
	if (generateAllAIBtn) {
		generateAllAIBtn.addEventListener('click', async () => {
			if (!confirm('将为当前所有辩题各按流程设置生成一批 AI 内容，是否继续？')) return;
			const originalText = generateAllAIBtn.textContent;
			try {
				generateAllAIBtn.disabled = true;
				generateAllAIBtn.textContent = '生成中...';
				const res = typeof generateAIContentForAllStreams === 'function' ? await generateAIContentForAllStreams() : null;
				const data = (res && res.generated) ? res.generated : (res && res.data && res.data.generated) ? res.data.generated : {};
				const total = Object.values(data).reduce((sum, o) => sum + (o.count || 0), 0);
				if (typeof showToast === 'function') showToast('已为 ' + Object.keys(data).length + ' 个辩题生成共 ' + total + ' 条 AI 内容', 'success');
				if (typeof loadAIContentList === 'function') await loadAIContentList(1);
			} catch (error) {
				console.error('❌ 一键生成失败:', error);
				if (typeof showToast === 'function') showToast('生成失败：' + (error.message || '未知错误'), 'error');
			} finally {
				generateAllAIBtn.disabled = false;
				generateAllAIBtn.textContent = originalText;
			}
		});
	}
	
	// 暂停AI识别
	const pauseAIBtn = document.getElementById('pause-ai-btn');
	if (pauseAIBtn) {
		pauseAIBtn.addEventListener('click', async () => {
			// 🔧 修复：将 originalText 定义在 try 块外，确保 finally 块能访问
			const originalText = pauseAIBtn.textContent;
			
			try {
				console.log('⏸️ 暂停AI识别...');
				
				// 禁用按钮，防止重复点击
				pauseAIBtn.disabled = true;
				pauseAIBtn.textContent = '暂停中...';
				
				const result = await toggleAI('pause', true);
				
				// 🔧 兼容两种返回格式
				const isSuccess = result && (result.success || result.status === 'paused');
				
				if (isSuccess) {
					console.log('✅ AI识别已暂停', result);
					updateAIControlButtons('paused');
					if (typeof showToast === 'function') {
						showToast('AI识别已暂停', 'success');
					}
				} else {
					console.error('❌ 暂停AI识别失败:', result);
					if (typeof showToast === 'function') {
						showToast('暂停AI识别失败：' + (result?.message || '未知错误'), 'error');
					}
				}
			} catch (error) {
				console.error('❌ 暂停AI识别失败:', error);
				if (typeof showToast === 'function') {
					showToast('暂停AI识别失败：' + error.message, 'error');
				}
			} finally {
				// 恢复按钮状态
				pauseAIBtn.disabled = false;
				pauseAIBtn.textContent = originalText;
			}
		});
	}
	
	// 恢复AI识别
	const resumeAIBtn = document.getElementById('resume-ai-btn');
	if (resumeAIBtn) {
		resumeAIBtn.addEventListener('click', async () => {
			// 🔧 修复：将 originalText 定义在 try 块外，确保 finally 块能访问
			const originalText = resumeAIBtn.textContent;
			
			try {
				console.log('▶️ 恢复AI识别...');
				
				// 禁用按钮，防止重复点击
				resumeAIBtn.disabled = true;
				resumeAIBtn.textContent = '恢复中...';
				
				const result = await toggleAI('resume', true);
				
				// 🔧 兼容两种返回格式
				const isSuccess = result && (result.success || result.status === 'running');
				
				if (isSuccess) {
					console.log('✅ AI识别已恢复', result);
					updateAIControlButtons('running');
					if (typeof showToast === 'function') {
						showToast('AI识别已恢复', 'success');
					}
				} else {
					console.error('❌ 恢复AI识别失败:', result);
					if (typeof showToast === 'function') {
						showToast('恢复AI识别失败：' + (result?.message || '未知错误'), 'error');
					}
				}
			} catch (error) {
				console.error('❌ 恢复AI识别失败:', error);
				if (typeof showToast === 'function') {
					showToast('恢复AI识别失败：' + error.message, 'error');
				}
			} finally {
				// 恢复按钮状态
				resumeAIBtn.disabled = false;
				resumeAIBtn.textContent = originalText;
			}
		});
	}
	
	// 刷新AI内容
	const refreshAIBtn = document.getElementById('refresh-ai-content-btn');
	if (refreshAIBtn) {
		refreshAIBtn.addEventListener('click', async () => {
			await loadAIContentList();
		});
	}
}

// 更新AI控制按钮状态
function updateAIControlButtons(status) {
	const startBtn = document.getElementById('start-ai-btn');
	const stopBtn = document.getElementById('stop-ai-btn');
	const pauseBtn = document.getElementById('pause-ai-btn');
	const resumeBtn = document.getElementById('resume-ai-btn');
	const statusIcon = document.getElementById('ai-status-icon');
	const statusText = document.getElementById('ai-status-text');
	
	// 更新状态显示
	if (statusIcon && statusText) {
		switch (status) {
			case 'running':
				statusIcon.textContent = '🟢';
				statusText.textContent = '运行中';
				statusText.style.color = '#4CAF50';
				break;
			case 'paused':
				statusIcon.textContent = '🟡';
				statusText.textContent = '已暂停';
				statusText.style.color = '#FF9800';
				break;
			case 'stopped':
				statusIcon.textContent = '⚪';
				statusText.textContent = '未启动';
				statusText.style.color = '#666';
				break;
		}
	}
	
	// 更新按钮状态
	if (startBtn && stopBtn && pauseBtn && resumeBtn) {
		switch (status) {
			case 'running':
				startBtn.disabled = true;
				stopBtn.disabled = false;
				pauseBtn.disabled = false;
				pauseBtn.style.display = '';
				resumeBtn.style.display = 'none';
				break;
			case 'paused':
				startBtn.disabled = true;
				stopBtn.disabled = false;
				pauseBtn.style.display = 'none';
				resumeBtn.style.display = '';
				resumeBtn.disabled = false;
				break;
			case 'stopped':
				startBtn.disabled = false;
				stopBtn.disabled = true;
				pauseBtn.disabled = true;
				pauseBtn.style.display = '';
				resumeBtn.style.display = 'none';
				break;
		}
	}
}

/**
 * 🔧 查询并更新指定流的 AI 状态
 * @param {string} streamId - 直播流ID
 */
async function updateAIStatusForStream(streamId) {
	if (!streamId) {
		console.warn('⚠️ updateAIStatusForStream: streamId 为空');
		updateAIControlButtons('stopped');
		return;
	}
	
	try {
		console.log(`🔍 查询流 ${streamId} 的 AI 状态...`);
		
		// 🔧 关键修复：使用 fetchDashboardByStream 查询特定流的状态
		let dashboard = null;
		
		// 优先使用按 streamId 查询的 API
		if (typeof fetchDashboardByStream === 'function') {
			const result = await fetchDashboardByStream(streamId);
			// 处理响应格式：可能是 {success: true, data: {...}} 或直接是数据
			dashboard = result?.data || result;
			console.log(`📊 流 ${streamId} 的 Dashboard 数据 (按流查询):`, dashboard);
		} else {
			// 降级方案：使用全局 Dashboard API（可能不准确）
			console.warn('⚠️ fetchDashboardByStream 不存在，使用全局 Dashboard API');
			dashboard = await fetchDashboard();
			console.log('📊 Dashboard 数据 (全局):', dashboard);
		}
		
		if (dashboard && dashboard.aiStatus) {
			console.log(`✅ 流 ${streamId} 的 AI 状态: ${dashboard.aiStatus}`);
			updateAIControlButtons(dashboard.aiStatus);
			
			// 更新全局状态
			if (window.globalState) {
				window.globalState.aiStatus = dashboard.aiStatus;
			}
		} else {
			// 如果没有 AI 状态，默认为 stopped
			console.log(`⚠️ 流 ${streamId} 没有 AI 状态信息，默认为 stopped`);
			updateAIControlButtons('stopped');
		}
	} catch (error) {
		console.error(`❌ 查询流 ${streamId} 的 AI 状态失败:`, error);
		// 出错时默认为 stopped
		updateAIControlButtons('stopped');
	}
}

/**
 * 根据流程环节纯模拟生成辩论内容（无直播版）
 * 规则：时长对应字数（3~4字/秒），方向对应正方/反方/双方
 * @param {Array<{name:string, duration:number, side:string}>} segments - 环节列表
 * @returns {Array<{text:string, side:string}>} 用于 POST 到 addAIContent 的列表
 */
function generateMockContentFromSegments(segments) {
	if (!Array.isArray(segments) || segments.length === 0) return [];
	const charsPerSecond = 3.5; // 语速 3~4 字/秒，取 3.5
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

// 加载AI内容列表
async function loadAIContentList(page = 1) {
	// 获取当前选择的辩题（流ID 与辩题一一对应）
	const streamSelect = document.getElementById('ai-stream-select');
	const streamId = streamSelect ? streamSelect.value : null;
	
	// 如果选择了流，显示流信息；否则隐藏
	if (streamId) {
		const streamsResult = await getStreamsList();
		if (streamsResult && streamsResult.streams) {
			const stream = streamsResult.streams.find(s => s.id === streamId);
			if (stream) {
				showAIContentStreamInfo(stream.name || 'Unnamed');
			}
		}
	} else {
		hideAIContentStreamInfo();
	}
	
	const data = await fetchAIContentList(page, 20, null, null, streamId);
	if (!data) {
		const container = document.getElementById('ai-content-list');
		if (container) {
			container.innerHTML = '<div style="text-align: center; padding: 40px; color: #999;">请先选择辩题</div>';
		}
		return;
	}
	
	const container = document.getElementById('ai-content-list');
	if (!container) return;
	
	if (!data.items || data.items.length === 0) {
		container.innerHTML = '<div style="text-align: center; padding: 40px; color: #999;">暂无AI内容，点击「启动AI识别」将根据当前流程设置纯模拟生成辩论内容</div>';
		return;
	}
	
	// 渲染内容列表
	container.innerHTML = data.items.map(item => {
		// 转义HTML特殊字符以防止XSS
		const safeContent = (item.content || item.text || '').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
		const safeId = (item.id || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
		const timestamp = item.timestamp || '';
		
		return `
			<div class="ai-content-item" style="padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px; margin-bottom: 15px; background: white;">
				<div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 10px;">
					<div style="flex: 1;">
						<span style="display: inline-block; padding: 4px 12px; border-radius: 12px; font-size: 12px; background: ${item.position === 'left' ? '#e8f5e9' : '#e3f2fd'}; color: ${item.position === 'left' ? '#4CAF50' : '#2196F3'}; margin-right: 10px;">
							${item.position === 'left' ? '⚔️ 正方' : '🛡️ 反方'}
						</span>
						<span style="color: #999; font-size: 12px;">${timestamp}</span>
						<span style="color: #999; font-size: 12px; margin-left: 10px;">置信度: ${((item.confidence || 0) * 100).toFixed(0)}%</span>
					</div>
					<button class="btn btn-danger btn-sm" onclick="deleteAIContentItem('${safeId}')" style="padding: 4px 12px;">删除</button>
				</div>
				<div style="color: #333; line-height: 1.6; margin-bottom: 10px;">${safeContent}</div>
				<div style="display: flex; gap: 15px; color: #999; font-size: 12px; margin-bottom: 10px;">
					<span>👁️ ${(item.statistics && item.statistics.views) || 0} 查看</span>
					<span>❤️ ${(item.statistics && item.statistics.likes) || 0} 点赞</span>
					<span>💬 ${(item.statistics && item.statistics.comments) || 0} 评论</span>
				</div>
				<div style="display: flex; gap: 10px;">
					<button class="btn btn-danger btn-sm" onclick="deleteAIContentItem('${safeId}')" style="padding: 4px 12px;">删除</button>
					${(item.statistics && item.statistics.comments > 0) ? `<button class="btn btn-primary btn-sm" onclick='openCommentsModal("${safeId}")' style="padding: 4px 12px;">查看评论 (${item.statistics.comments})</button>` : '<button class="btn btn-secondary btn-sm" disabled style="padding: 4px 12px;">暂无评论</button>'}
				</div>
			</div>
		`;
	}).join('');
	
	// 更新分页（新接口返回格式：{ total, page, items }）
	const pagination = document.getElementById('ai-content-pagination');
	if (pagination) {
		const totalPages = data.total ? Math.ceil(data.total / 20) : 0;
		if (totalPages > 1) {
			pagination.style.display = 'block';
			const pageInfo = document.getElementById('ai-page-info');
			if (pageInfo) {
				pageInfo.textContent = `第 ${data.page || page} 页 / 共 ${totalPages} 页`;
			}
		} else {
			pagination.style.display = 'none';
		}
	}
}

// 删除AI内容（全局函数，供HTML onclick调用）
window.deleteAIContentItem = async function(contentId) {
	if (!confirm('确定要删除这条AI内容吗？')) {
		return;
	}
	
	const reason = prompt('请输入删除原因（可选）：');
	const result = await deleteAIContent(contentId, reason || '管理员删除', true);
	if (result) {
		// 重新加载列表
		await loadAIContentList();
	}
};

// ==================== 直播控制事件 ====================

// 立即更新直播状态UI（乐观更新）
// isPaused: 暂停状态（已停止但可点「开启」恢复）；未传则按 false 处理
function updateLiveStatusUI(isLive, isPaused) {
	if (typeof isPaused === 'undefined') isPaused = false;
	window.livePaused = isPaused;

	// 右上角「开始直播」按钮仅由用户点击该按钮时切换，不在此处根据 isLive 更新

	// 更新顶部状态显示
	const statusText = document.getElementById('live-status-text');
	if (statusText) {
		statusText.textContent = isLive ? '直播中' : (isPaused ? '已暂停' : '未直播');
	}
	const liveStatusEl = document.getElementById('live-status');
	if (liveStatusEl) {
		liveStatusEl.innerHTML = isLive ? '<span style="color: #27ae60;">直播中</span>' : (isPaused ? '<span style="color: #f39c12;">已暂停</span>' : '<span style="color: #95a5a6;">未直播</span>');
	}

	// 更新直播控制页面按钮：开始→暂停/开启，停止→关闭
	const adminStartLiveBtn = document.getElementById('admin-start-live-btn');
	const adminStopLiveBtn = document.getElementById('admin-stop-live-btn');
	if (adminStartLiveBtn && adminStopLiveBtn) {
		adminStartLiveBtn.disabled = false;
		if (isLive) {
			adminStartLiveBtn.textContent = '暂停';
			adminStopLiveBtn.disabled = false;
			adminStopLiveBtn.textContent = '关闭';
		} else if (isPaused) {
			adminStartLiveBtn.textContent = '开启';
			adminStopLiveBtn.disabled = false;
			adminStopLiveBtn.textContent = '关闭';
		} else {
			adminStartLiveBtn.innerHTML = '<img src="/static/iconfont/bofang.png" class="icon-img-sm" style="filter: brightness(0) invert(1);" alt="">开始直播';
			adminStopLiveBtn.disabled = true;
			adminStopLiveBtn.textContent = '关闭';
		}
	}

	// 更新直播控制页面状态显示
	const liveControlStatusEl = document.getElementById('live-control-status');
	if (liveControlStatusEl) {
		if (isLive) {
			liveControlStatusEl.innerHTML = '<span style="color: #4CAF50;">🟢 直播中</span>';
		} else if (isPaused) {
			liveControlStatusEl.innerHTML = '<span style="color: #f39c12;">⏸ 已暂停（可点「开启」恢复）</span>';
		} else {
			liveControlStatusEl.innerHTML = '<span style="color: #999;">⚪ 未直播</span>';
			const streamInfoEl = document.getElementById('live-stream-info');
			if (streamInfoEl) streamInfoEl.style.display = 'none';
		}
	}

	// 更新全局状态
	if (window.globalState) {
		window.globalState.isLive = isLive;
	}
}

// 获取流列表（包含 liveStatus）
async function getStreamsWithStatus() {
	const result = await (typeof getStreamsList === 'function' ? getStreamsList() : null);
	if (Array.isArray(result)) return result;
	if (result?.data?.streams) return result.data.streams;
	if (result?.streams) return result.streams;
	if (result?.data && Array.isArray(result.data)) return result.data;
	return [];
}

// “开始直播”：开启所有启用的直播流
async function startAllEnabledStreams(autoStartAI = false) {
	const streams = await getStreamsWithStatus();
	const enabled = streams.filter(s => s.enabled !== false);
	const tasks = enabled.map(s => startLive(s.id, autoStartAI, true));
	const results = await Promise.allSettled(tasks);
	return { enabledCount: enabled.length, results };
}

// “停止直播”：停止所有正在直播的流
async function stopAllLiveStreams() {
	const streams = await getStreamsWithStatus();
	const live = streams.filter(s => s.liveStatus && s.liveStatus.isLive);
	const tasks = live.map(s => stopLive(s.id, true, true));
	const results = await Promise.allSettled(tasks);
	return { liveCount: live.length, results };
}

function initLiveControlEvents() {
	// 顶部直播控制按钮（纯前端 Mock 模拟，不调用直播接口）
	const controlLiveBtn = document.getElementById('control-live-btn');
	if (controlLiveBtn) {
		controlLiveBtn.addEventListener('click', async () => {
			const isLive = typeof mockIsAnyLive === 'function' ? mockIsAnyLive() : false;
			const isPaused = window.livePaused || false;
			// 已暂停：点击「开启」恢复直播
			if (isPaused) {
				confirm('所有直播流一起开启，是否启动AI识别内容');
				let streams = window.liveSetupStreams || [];
				if (streams.length === 0 && typeof getStreamsList === 'function') {
					try {
						const r = await getStreamsList();
						streams = Array.isArray(r) ? r : (r?.data?.streams || r?.streams || []);
						window.liveSetupStreams = streams;
					} catch (e) {}
				}
				let enabledIds = streams.filter(s => s.enabled !== false).map(s => s.id);
				if (enabledIds.length === 0) enabledIds = ['mock-simulation-stream'];
				if (typeof mockStartAllLive === 'function') mockStartAllLive(enabledIds);
				window.livePaused = false;
				if (window.globalState) window.globalState.isLive = true;
				if (typeof updateLiveStatusUI === 'function') updateLiveStatusUI(true, false);
				controlLiveBtn.textContent = '关闭直播';
				controlLiveBtn.classList.remove('btn-primary', 'btn-success');
				controlLiveBtn.classList.add('btn-danger');
			} else if (isLive) {
				// 直播中：点击「关闭直播」→ 停止所有流，大屏恢复原样（关闭弹窗）
				if (typeof mockStopAllLive === 'function') mockStopAllLive();
				window.livePaused = false;
				if (window.globalState) window.globalState.isLive = false;
				if (typeof updateLiveStatusUI === 'function') updateLiveStatusUI(false, false);
				controlLiveBtn.textContent = '开始直播';
				controlLiveBtn.classList.remove('btn-danger');
				controlLiveBtn.classList.add('btn-primary');
				if (typeof closeStreamDetailModalIfOpen === 'function') closeStreamDetailModalIfOpen();
			} else {
				// 未开播：点击「开始直播」
				confirm('所有直播流一起开启，是否启动AI识别内容');
				let streams = window.liveSetupStreams || [];
				if (streams.length === 0 && typeof getStreamsList === 'function') {
					try {
						const r = await getStreamsList();
						streams = Array.isArray(r) ? r : (r?.data?.streams || r?.streams || []);
						window.liveSetupStreams = streams;
					} catch (e) {}
				}
				let enabledIds = streams.filter(s => s.enabled !== false).map(s => s.id);
				if (enabledIds.length === 0) {
					enabledIds = ['mock-simulation-stream'];
					if (typeof showToast === 'function') showToast('已开启模拟直播数据（无真实推流）', 'info');
				}
				if (typeof mockStartAllLive === 'function') mockStartAllLive(enabledIds);
				if (typeof updateLiveStatusUI === 'function') updateLiveStatusUI(true, false);
				controlLiveBtn.textContent = '关闭直播';
				controlLiveBtn.classList.remove('btn-primary', 'btn-success');
				controlLiveBtn.classList.add('btn-danger');
			}
			if (typeof mockUpdateSimulationTimers === 'function') mockUpdateSimulationTimers();
			if (typeof renderMultiLiveOverview === 'function') renderMultiLiveOverview();
			if (typeof updateMockGlobalStats === 'function') updateMockGlobalStats();
		});
	}
	
	// 直播控制页面的开始/停止按钮
	const adminStartLiveBtn = document.getElementById('admin-start-live-btn');
	const adminStopLiveBtn = document.getElementById('admin-stop-live-btn');
	
	if (adminStartLiveBtn) {
		adminStartLiveBtn.addEventListener('click', async () => {
			// 开启直播时弹出提示：确定=启动AI，取消=不启动AI
			const wantAI = confirm('所有直播流一起开启，是否启动AI识别内容');
			const autoStartAI = wantAI; // 确定=启动AI，取消=不启动AI
			// 在函数开始就保存按钮文本，确保 finally 块中可以使用
			const originalText = adminStartLiveBtn.textContent;
			
			try {
				// 若当前是“暂停”状态，点击为“开启”（恢复直播）
				if (window.livePaused) {
					adminStartLiveBtn.disabled = true;
					adminStartLiveBtn.textContent = '开启中...';
					window.livePaused = false;
					updateLiveStatusUI(true, false);
					await startAllEnabledStreams(document.getElementById('auto-start-ai-checkbox')?.checked || false);
					if (typeof showToast === 'function') showToast('直播已恢复', 'success');
					if (adminStartLiveBtn) { adminStartLiveBtn.disabled = false; adminStartLiveBtn.textContent = '暂停'; }
					if (adminStopLiveBtn) { adminStopLiveBtn.disabled = false; adminStopLiveBtn.textContent = '关闭'; }
					if (typeof loadAllStreamsStatus === 'function') loadAllStreamsStatus();
					if (typeof renderMultiLiveOverview === 'function') renderMultiLiveOverview();
					return;
				}
				// 若当前是直播中，点击为“暂停”
				if (window.globalState && window.globalState.isLive) {
					if (!confirm('确定要暂停直播吗？暂停后可点击「开启」恢复。')) return;
					adminStartLiveBtn.disabled = true;
					adminStartLiveBtn.textContent = '暂停中...';
					await stopAllLiveStreams();
					window.livePaused = true;
					window.globalState.isLive = false;
					updateLiveStatusUI(false, true);
					if (typeof closeStreamDetailModalIfOpen === 'function') closeStreamDetailModalIfOpen();
					if (typeof showToast === 'function') showToast('已暂停，可点击「开启」恢复', 'info');
					if (adminStartLiveBtn) { adminStartLiveBtn.disabled = false; adminStartLiveBtn.textContent = '开启'; }
					if (adminStopLiveBtn) { adminStopLiveBtn.disabled = false; adminStopLiveBtn.textContent = '关闭'; }
					if (typeof loadAllStreamsStatus === 'function') loadAllStreamsStatus();
					if (typeof renderMultiLiveOverview === 'function') renderMultiLiveOverview();
					return;
				}
				if (!confirm(`确定要开始直播吗？\n\n将开启所有“已启用”的直播流。\n${autoStartAI ? '（将自动启动AI识别）' : '（不启动AI识别）'}`)) {
					return;
				}
				
				// 禁用按钮，防止重复点击
				adminStartLiveBtn.disabled = true;
				adminStartLiveBtn.textContent = '启动中...';
				
				// 立即更新UI（乐观更新）
				updateLiveStatusUI(true, false);
				
				await startAllEnabledStreams(autoStartAI);
				console.log('✅ 开始直播成功（全部启用流）');
				
				// 开播后注入 mock 用户（50 个，头像默认 wode.png），模拟真实观众
				if (typeof seedMockUsers === 'function') {
					seedMockUsers().then(() => console.log('✅ mock 用户已注入')).catch(() => {});
				}
				
				// 显示成功提示
				if (typeof showToast === 'function') {
					showToast('直播已开始！', 'success');
				}
				
				// 更新全局状态
				if (window.globalState) window.globalState.isLive = true;
				
				// 确保UI状态更新为已开播（按钮变为暂停/关闭）
				updateLiveStatusUI(true, false);
				
				// 多流开播：不显示单一流信息
				
				// 如果自动启动了AI，设置定时刷新AI内容
				if (autoStartAI) {
					setTimeout(() => {
						if (typeof loadAIContentList === 'function') {
							console.log('📡 AI已自动启动，开始订阅AI内容更新...');
							loadAIContentList(1);
						}
						
						// 设置定时刷新AI内容列表
						if (window.aiContentRefreshTimer) {
							clearInterval(window.aiContentRefreshTimer);
						}
						window.aiContentRefreshTimer = setInterval(() => {
							if (typeof loadAIContentList === 'function') {
								loadAIContentList(1);
							}
						}, 5000); // 每5秒刷新一次
					}, 2000); // 延迟2秒，等待后端ASR服务启动
				}
				
				if (typeof loadAllStreamsStatus === 'function') loadAllStreamsStatus();
				if (typeof renderMultiLiveOverview === 'function') renderMultiLiveOverview();
				
				// 刷新 dashboard 和状态列表（确保状态同步）
				// 注意：延迟刷新，但不要覆盖我们刚设置的本地状态
				setTimeout(() => {
					if (typeof loadDashboard === 'function') loadDashboard();
					if (typeof loadAllStreamsStatus === 'function') loadAllStreamsStatus();
					if (typeof loadLiveSetup === 'function') loadLiveSetup();
				}, 800);
			} catch (error) {
				// API异常，回滚UI
				updateLiveStatusUI(false, false);
				console.error('❌ 开始直播失败:', error);
				const errorMsg = error.message || '网络错误或服务器异常';
				if (typeof showToast === 'function') {
					showToast('开始直播失败：' + errorMsg, 'error');
				} else {
					alert('开始直播失败：' + errorMsg);
				}
			} finally {
				setTimeout(() => {
					if (adminStartLiveBtn && typeof updateLiveStatusUI === 'function') {
						const isLive = window.globalState?.isLive || false;
						const isPaused = window.livePaused || false;
						updateLiveStatusUI(isLive, isPaused);
					}
				}, 500);
			}
		});
	}
	
	if (adminStopLiveBtn) {
		adminStopLiveBtn.addEventListener('click', async () => {
			// 在函数开始就保存按钮文本，确保 finally 块中可以使用
			const originalText = adminStopLiveBtn.textContent;
			
			try {
				if (!confirm('确定要停止所有直播流吗？')) return;
				
				// 禁用按钮，防止重复点击
				adminStopLiveBtn.disabled = true;
				adminStopLiveBtn.textContent = '停止中...';
				
				// 立即更新UI（乐观更新）
				window.livePaused = false;
				updateLiveStatusUI(false, false);
				
				await stopAllLiveStreams();
				console.log('✅ 停止直播成功（全部直播流）');
				if (typeof closeStreamDetailModalIfOpen === 'function') closeStreamDetailModalIfOpen();
				
				if (typeof showToast === 'function') {
					showToast('直播已关闭', 'success');
				}
				
				if (window.globalState) window.globalState.isLive = false;
				window.lastStopLiveTime = Date.now();
				updateLiveStatusUI(false, false);
				
				const streamInfoEl = document.getElementById('live-stream-info');
				if (streamInfoEl) streamInfoEl.style.display = 'none';
				
				// 清理AI内容刷新定时器
				if (window.aiContentRefreshTimer) {
					clearInterval(window.aiContentRefreshTimer);
					window.aiContentRefreshTimer = null;
					console.log('🧹 已清理AI内容刷新定时器');
				}
				
				if (typeof loadAllStreamsStatus === 'function') loadAllStreamsStatus();
				if (typeof renderMultiLiveOverview === 'function') renderMultiLiveOverview();
				
				// 刷新 dashboard 和状态列表（确保状态同步）
				// 注意：延迟刷新，但不要覆盖我们刚设置的本地状态
				setTimeout(() => {
					if (typeof loadDashboard === 'function') loadDashboard();
					if (typeof loadAllStreamsStatus === 'function') loadAllStreamsStatus();
					if (typeof loadLiveSetup === 'function') loadLiveSetup();
				}, 800);
			} catch (error) {
				updateLiveStatusUI(window.globalState?.isLive || false, window.livePaused || false);
				console.error('❌ 停止直播失败:', error);
				const errorMsg = error.message || '网络错误或服务器异常';
				if (typeof showToast === 'function') {
					showToast('停止直播失败：' + errorMsg, 'error');
				} else {
					alert('停止直播失败：' + errorMsg);
				}
			} finally {
				setTimeout(() => {
					if (typeof updateLiveStatusUI === 'function') {
						updateLiveStatusUI(window.globalState?.isLive || false, window.livePaused || false);
					}
				}, 500);
			}
		});
	}
}

// ==================== AI直播流列表加载 ====================

/**
 * 加载AI控制的直播流列表
 */
async function loadAIStreamsList() {
	const aiStreamSelect = document.getElementById('ai-stream-select');
	if (!aiStreamSelect) return;
	
	try {
		console.log('📡 加载AI直播流列表...');
		
		const currentValue = aiStreamSelect.value;
		const streams = typeof getStreamsListNormalized === 'function'
			? await getStreamsListNormalized()
			: (await getStreamsList())?.streams || (await getStreamsList())?.data?.streams || [];
		
		const enabledStreams = Array.isArray(streams) ? streams.filter(s => s.enabled !== false) : [];
		
		aiStreamSelect.innerHTML = '<option value="">请选择辩题</option>';
		
		if (enabledStreams.length === 0) {
			aiStreamSelect.innerHTML = '<option value="">暂无可用的辩题，可先添加直播流（辩题与流一一对应）</option>';
			console.warn('⚠️ 没有可用的直播流');
			return;
		}
		
		enabledStreams.forEach(stream => {
			const option = document.createElement('option');
			option.value = stream.id;
			option.textContent = `${stream.name || '未命名'} (${(stream.type || 'hls').toUpperCase()})`;
			aiStreamSelect.appendChild(option);
		});
		
		if (currentValue && Array.from(aiStreamSelect.options).some(o => o.value === currentValue)) {
			aiStreamSelect.value = currentValue;
		}
		
		console.log(`✅ AI直播流列表已加载（${enabledStreams.length} 个）`);
	} catch (error) {
		console.error('❌ 加载AI直播流列表失败:', error);
		aiStreamSelect.innerHTML = '<option value="">加载失败，请刷新</option>';
	}
}

/**
 * 显示AI内容当前流信息
 */
function showAIContentStreamInfo(streamName) {
	const infoEl = document.getElementById('ai-content-stream-info');
	const nameEl = document.getElementById('ai-content-current-stream-name');
	
	if (infoEl) infoEl.style.display = 'block';
	if (nameEl) nameEl.textContent = streamName;
}

/**
 * 隐藏AI内容当前流信息
 */
function hideAIContentStreamInfo() {
	const infoEl = document.getElementById('ai-content-stream-info');
	if (infoEl) infoEl.style.display = 'none';
}

// ==================== 观看人数管理 ====================

/**
 * 更新Dashboard页面的观看人数显示
 * @param {string} streamId - 直播流ID
 * @param {number} count - 观看人数
 * @param {string} action - 触发动作
 */
function updateViewersDisplay(streamId, count, action) {
	// 在Dashboard页面更新观看人数
	const viewersCountEl = document.getElementById('viewers-count');
	const activeUsersEl = document.getElementById('active-users');
	
	if (viewersCountEl) {
		viewersCountEl.textContent = count;
		
		// 添加动画效果
		viewersCountEl.classList.add('highlight');
		setTimeout(() => {
			viewersCountEl.classList.remove('highlight');
		}, 1000);
	}
	
	// 同时更新活跃用户数（假设观看人数等于活跃用户数）
	if (activeUsersEl) {
		activeUsersEl.textContent = count;
		
		// 添加动画效果
		activeUsersEl.classList.add('highlight');
		setTimeout(() => {
			activeUsersEl.classList.remove('highlight');
		}, 1000);
	}
	
	console.log(`✅ 已更新观看人数显示: 流 ${streamId}, 人数 ${count}`);
}

/**
 * 更新多直播总览中某个流的观看人数
 * @param {string} streamId - 直播流ID
 * @param {number} count - 观看人数
 */
function updateStreamViewersInList(streamId, count) {
	// 在多直播总览页面更新指定流的观看人数
	const streamCard = document.querySelector(`[data-stream-id="${streamId}"]`);
	if (!streamCard) {
		console.log(`⚠️ 未找到流 ${streamId} 的卡片元素`);
		return;
	}
	
	const viewersEl = streamCard.querySelector('.stream-viewers, .viewers-count');
	if (viewersEl) {
		viewersEl.textContent = `${count} 人观看`;
		
		// 添加动画效果
		viewersEl.classList.add('highlight');
		setTimeout(() => {
			viewersEl.classList.remove('highlight');
		}, 1000);
		
		console.log(`✅ 已更新流 ${streamId} 的观看人数: ${count}`);
	}
}

/**
 * 初始化观看人数显示
 * @param {string} streamId - 直播流ID（可选）
 */
async function initViewersCount(streamId = null) {
	try {
		let result;
		
		if (streamId) {
			// 获取指定流的观看人数
			result = await getViewersCount(streamId);
			if (result?.success && result.data) {
				updateViewersDisplay(streamId, result.data.viewers, 'manual_broadcast');
			}
		} else {
			// 获取所有流的观看人数
			result = await getAllViewersCount();
			if (result?.success && result.data?.streams) {
				// 更新多直播总览中的观看人数
				Object.entries(result.data.streams).forEach(([sid, count]) => {
					updateStreamViewersInList(sid, count);
				});
			}
		}
	} catch (error) {
		console.error('❌ 初始化观看人数失败:', error);
	}
}

// ==================== 辩论流程管理事件 ====================

/**
 * 初始化辩论流程管理事件
 */
function initDebateFlowEvents() {
	console.log('🎯 初始化辩论流程事件处理器...');
	
	// 加载流列表
	loadDebateFlowStreamsList();
	
	// 刷新流列表按钮
	const refreshStreamsBtn = document.getElementById('debate-flow-refresh-streams-btn');
	if (refreshStreamsBtn) {
		refreshStreamsBtn.addEventListener('click', () => {
			loadDebateFlowStreamsList();
		});
	}
	
	// 流选择变化时，加载对应流的流程配置
	const streamSelect = document.getElementById('debate-flow-stream-select');
	if (streamSelect) {
		streamSelect.addEventListener('change', async (e) => {
			const streamId = e.target.value;
			if (streamId) {
				await loadDebateFlowByStream(streamId);
			} else {
				clearDebateFlowDisplay();
			}
		});
	}
	
	// 添加环节按钮
	const addSegmentBtn = document.getElementById('add-segment-btn');
	if (addSegmentBtn) {
		addSegmentBtn.addEventListener('click', addDebateSegment);
	}
	
	// 保存流程配置按钮
	const saveFlowBtn = document.getElementById('save-debate-flow-btn');
	if (saveFlowBtn) {
		saveFlowBtn.addEventListener('click', async () => {
			const streamId = document.getElementById('debate-flow-stream-select')?.value;
			if (!streamId) {
				alert('请先选择辩题');
				return;
			}
			await saveDebateFlowConfig(streamId);
		});
	}
}

/**
 * 加载流列表到辩论流程选择器
 */
async function loadDebateFlowStreamsList() {
	try {
		const streamSelect = document.getElementById('debate-flow-stream-select');
		if (!streamSelect) return;
		
		const streams = typeof getStreamsListNormalized === 'function'
			? await getStreamsListNormalized()
			: (await getStreamsList())?.streams || (await getStreamsList())?.data?.streams || [];
		
		if (!Array.isArray(streams)) {
			console.warn('⚠️ 无法获取流列表');
			return;
		}
		
		const currentValue = streamSelect.value;
		streamSelect.innerHTML = '<option value="">请选择辩题</option>';
		
		streams.forEach(stream => {
			if (stream.enabled !== false) {
				const option = document.createElement('option');
				option.value = stream.id;
				option.textContent = `${stream.name || '未命名'} (${(stream.type || 'hls').toUpperCase()})`;
				streamSelect.appendChild(option);
			}
		});
		
		if (currentValue && Array.from(streamSelect.options).some(o => o.value === currentValue)) {
			streamSelect.value = currentValue;
			streamSelect.dispatchEvent(new Event('change', { bubbles: true }));
		}
	} catch (error) {
		console.error('❌ 加载辩论流程流列表失败:', error);
	}
}

/**
 * 加载指定流的辩论流程配置
 */
async function loadDebateFlowByStream(streamId) {
	try {
		const container = document.getElementById('debate-segments-container');
		if (!container) return;
		
		container.innerHTML = '<div style="text-align: center; padding: 20px;"><span style="color: #999;">加载中...</span></div>';
		
		// 从 API 获取流程配置
		const result = await getDebateFlowConfig(streamId);
		
		if (!result || !result.segments) {
			console.warn('⚠️ 无法获取流程配置');
			container.innerHTML = '<div style="text-align: center; padding: 20px; color: #999;">暂无流程配置，可点击「添加环节」创建新环节（用于AI生成内容）</div>';
			return;
		}
		
		// 显示当前辩题名称
		const streamSelect = document.getElementById('debate-flow-stream-select');
		const currentStream = streamSelect.options[streamSelect.selectedIndex];
		if (currentStream) {
			const streamInfo = document.getElementById('debate-flow-current-stream-info');
			const streamName = document.getElementById('debate-flow-current-stream-name');
			streamName.textContent = currentStream.textContent;
			streamInfo.style.display = 'block';
		}
		
		// 渲染环节
		renderDebateSegments(result.segments);
	} catch (error) {
		console.error('❌ 加载流程配置失败:', error);
		const container = document.getElementById('debate-segments-container');
		if (container) {
			container.innerHTML = '<div style="text-align: center; padding: 20px; color: #e74c3c;">加载流程配置失败</div>';
		}
	}
}

/**
 * 渲染辩论环节列表
 */
function renderDebateSegments(segments) {
	const container = document.getElementById('debate-segments-container');
	if (!container) return;
	
	if (!segments || segments.length === 0) {
		container.innerHTML = '<div style="text-align: center; padding: 40px; color: #999;">暂无环节，可点击"添加环节"创建新环节</div>';
		return;
	}
	
	container.innerHTML = '';
	
	segments.forEach((segment, index) => {
		const segmentEl = document.createElement('div');
		segmentEl.className = 'debate-segment-item';
		segmentEl.dataset.segmentIndex = index;
		segmentEl.style.cssText = `
			background: #f8f9fa;
			padding: 20px;
			border-radius: 8px;
			border: 1px solid #e9ecef;
			display: flex;
			gap: 15px;
			align-items: flex-start;
		`;
		
		segmentEl.innerHTML = `
			<div style="flex: 1; min-width: 0;">
				<div style="display: flex; align-items: center; margin-bottom: 10px;">
					<span style="display: inline-block; width: 30px; height: 30px; background: #3498db; color: white; border-radius: 50%; text-align: center; line-height: 30px; font-weight: bold; margin-right: 10px; flex-shrink: 0;">${index + 1}</span>
					<input type="text" class="segment-name-input form-input" placeholder="环节名称（如：正方发言）" value="${segment.name || ''}" style="flex: 1; padding: 8px 12px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px;">
				</div>
				<div style="display: flex; gap: 10px; align-items: center;">
					<label style="display: flex; align-items: center; gap: 5px; font-size: 14px; color: #666;">
						时长（秒）:
						<input type="number" class="segment-duration-input form-input" placeholder="时长（秒）" value="${segment.duration || 180}" min="10" step="10" style="width: 80px; padding: 6px 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px;">
					</label>
					<label style="display: flex; align-items: center; gap: 5px; font-size: 14px; color: #666;">
						方向:
						<select class="segment-side-input form-select" style="padding: 6px 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px;">
							<option value="left" ${segment.side === 'left' ? 'selected' : ''}>正方</option>
							<option value="right" ${segment.side === 'right' ? 'selected' : ''}>反方</option>
							<option value="both" ${segment.side === 'both' ? 'selected' : ''}>双方</option>
						</select>
					</label>
				</div>
			</div>
			<button class="btn btn-danger btn-sm delete-segment-btn" style="padding: 8px 12px; display: flex; align-items: center; gap: 6px; flex-shrink: 0;">
				<span style="font-size: 16px;">🗑️</span>
				删除
			</button>
		`;
		
		// 删除按钮事件
		const deleteBtn = segmentEl.querySelector('.delete-segment-btn');
		if (deleteBtn) {
			deleteBtn.addEventListener('click', () => {
				if (confirm('确定要删除这个环节吗？')) {
					segmentEl.remove();
				}
			});
		}
		
		container.appendChild(segmentEl);
	});
}

/**
 * 添加新的辩论环节
 */
function addDebateSegment() {
	const container = document.getElementById('debate-segments-container');
	if (!container) return;
	
	// 如果容器是空提示，先清空
	if (container.innerHTML.includes('暂无环节') || container.innerHTML.includes('暂无流程配置') || container.innerHTML.includes('选择直播流后')) {
		container.innerHTML = '';
	}
	
	const items = container.querySelectorAll('.debate-segment-item');
	const index = items.length;
	
	const segmentEl = document.createElement('div');
	segmentEl.className = 'debate-segment-item';
	segmentEl.dataset.segmentIndex = index;
	segmentEl.style.cssText = `
		background: #f8f9fa;
		padding: 20px;
		border-radius: 8px;
		border: 1px solid #e9ecef;
		display: flex;
		gap: 15px;
		align-items: flex-start;
	`;
	
	segmentEl.innerHTML = `
		<div style="flex: 1; min-width: 0;">
			<div style="display: flex; align-items: center; margin-bottom: 10px;">
				<span style="display: inline-block; width: 30px; height: 30px; background: #3498db; color: white; border-radius: 50%; text-align: center; line-height: 30px; font-weight: bold; margin-right: 10px; flex-shrink: 0;">${index + 1}</span>
				<input type="text" class="segment-name-input form-input" placeholder="环节名称（如：正方发言）" style="flex: 1; padding: 8px 12px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px;">
			</div>
			<div style="display: flex; gap: 10px; align-items: center;">
				<label style="display: flex; align-items: center; gap: 5px; font-size: 14px; color: #666;">
					时长（秒）:
					<input type="number" class="segment-duration-input form-input" placeholder="时长（秒）" value="180" min="10" step="10" style="width: 80px; padding: 6px 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px;">
				</label>
				<label style="display: flex; align-items: center; gap: 5px; font-size: 14px; color: #666;">
					方向:
					<select class="segment-side-input form-select" style="padding: 6px 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px;">
						<option value="left">正方</option>
						<option value="right">反方</option>
						<option value="both" selected>双方</option>
					</select>
				</label>
			</div>
		</div>
		<button class="btn btn-danger btn-sm delete-segment-btn" style="padding: 8px 12px; display: flex; align-items: center; gap: 6px; flex-shrink: 0;">
			<span style="font-size: 16px;">🗑️</span>
			删除
		</button>
	`;
	
	// 删除按钮事件
	const deleteBtn = segmentEl.querySelector('.delete-segment-btn');
	if (deleteBtn) {
		deleteBtn.addEventListener('click', () => {
			if (confirm('确定要删除这个环节吗？')) {
				segmentEl.remove();
			}
		});
	}
	
	container.appendChild(segmentEl);
}

/**
 * 保存辩论流程配置
 */
async function saveDebateFlowConfig(streamId) {
	try {
		const container = document.getElementById('debate-segments-container');
		const items = container.querySelectorAll('.debate-segment-item');
		
		if (items.length === 0) {
			alert('请至少添加一个环节');
			return;
		}
		
		// 收集所有环节数据
		const segments = [];
		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			const name = item.querySelector('.segment-name-input')?.value || `环节 ${i + 1}`;
			const duration = parseInt(item.querySelector('.segment-duration-input')?.value) || 180;
			const side = item.querySelector('.segment-side-input')?.value || 'both';
			
			if (duration < 10) {
				alert('时长不能少于10秒');
				return;
			}
			
			segments.push({
				name,
				duration,
				side
			});
		}
		
		if (segments.length === 0) return;
		
		// 调用 API 保存
		const result = await saveDebateFlowConfigAPI(streamId, segments);
		
		if (result) {
			alert('✅ 流程配置保存成功！\n\n配置已同步到大屏幕。');
			// 刷新显示
			await loadDebateFlowByStream(streamId);
		}
	} catch (error) {
		console.error('❌ 保存流程配置失败:', error);
		alert('❌ 保存流程配置失败：' + error.message);
	}
}

/**
 * 清空流程显示
 */
function clearDebateFlowDisplay() {
	const container = document.getElementById('debate-segments-container');
	if (container) {
		container.innerHTML = '<div style="text-align: center; padding: 40px; color: #999;">选择直播流后，将显示该流的辩论流程</div>';
	}
	
	const streamInfo = document.getElementById('debate-flow-current-stream-info');
	if (streamInfo) {
		streamInfo.style.display = 'none';
	}
}

/**
 * 快速套用模板
 */
function applyTemplate(templateType) {
	const streamId = document.getElementById('debate-flow-stream-select')?.value;
	if (!streamId) {
		alert('请先选择要管理的直播流');
		return;
	}
	
	const templates = {
		standard: [
			{ name: '正方发言', duration: 180, side: 'left' },
			{ name: '反方质问', duration: 120, side: 'right' },
			{ name: '反方发言', duration: 180, side: 'right' },
			{ name: '正方质问', duration: 120, side: 'left' },
			{ name: '自由辩论', duration: 300, side: 'both' },
			{ name: '正方总结', duration: 120, side: 'left' },
			{ name: '反方总结', duration: 120, side: 'right' }
		],
		quick: [
			{ name: '正方发言', duration: 120, side: 'left' },
			{ name: '反方发言', duration: 120, side: 'right' },
			{ name: '自由辩论', duration: 180, side: 'both' },
			{ name: '正方总结', duration: 60, side: 'left' },
			{ name: '反方总结', duration: 60, side: 'right' }
		],
		extended: [
			{ name: '开场陈述', duration: 300, side: 'both' },
			{ name: '正方发言', duration: 240, side: 'left' },
			{ name: '反方质问', duration: 180, side: 'right' },
			{ name: '反方发言', duration: 240, side: 'right' },
			{ name: '正方质问', duration: 180, side: 'left' },
			{ name: '自由辩论', duration: 600, side: 'both' },
			{ name: '正方总结', duration: 180, side: 'left' },
			{ name: '反方总结', duration: 180, side: 'right' },
			{ name: '评委评议', duration: 300, side: 'both' }
		]
	};
	
	const template = templates[templateType];
	if (!template) return;
	
	if (!confirm('确定要套用此模板吗？这会覆盖当前的流程配置。')) {
		return;
	}
	
	const container = document.getElementById('debate-segments-container');
	container.innerHTML = '';
	
	template.forEach((segment, index) => {
		const segmentEl = document.createElement('div');
		segmentEl.className = 'debate-segment-item';
		segmentEl.dataset.segmentIndex = index;
		segmentEl.style.cssText = `
			background: #f8f9fa;
			padding: 20px;
			border-radius: 8px;
			border: 1px solid #e9ecef;
			display: flex;
			gap: 15px;
			align-items: flex-start;
		`;
		
		segmentEl.innerHTML = `
			<div style="flex: 1; min-width: 0;">
				<div style="display: flex; align-items: center; margin-bottom: 10px;">
					<span style="display: inline-block; width: 30px; height: 30px; background: #3498db; color: white; border-radius: 50%; text-align: center; line-height: 30px; font-weight: bold; margin-right: 10px; flex-shrink: 0;">${index + 1}</span>
					<input type="text" class="segment-name-input form-input" placeholder="环节名称" value="${segment.name}" style="flex: 1; padding: 8px 12px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px;">
				</div>
				<div style="display: flex; gap: 10px; align-items: center;">
					<label style="display: flex; align-items: center; gap: 5px; font-size: 14px; color: #666;">
						时长（秒）:
						<input type="number" class="segment-duration-input form-input" placeholder="时长（秒）" value="${segment.duration}" min="10" step="10" style="width: 80px; padding: 6px 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px;">
					</label>
					<label style="display: flex; align-items: center; gap: 5px; font-size: 14px; color: #666;">
						方向:
						<select class="segment-side-input form-select" style="padding: 6px 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px;">
							<option value="left" ${segment.side === 'left' ? 'selected' : ''}>正方</option>
							<option value="right" ${segment.side === 'right' ? 'selected' : ''}>反方</option>
							<option value="both" ${segment.side === 'both' ? 'selected' : ''}>双方</option>
						</select>
					</label>
				</div>
			</div>
			<button class="btn btn-danger btn-sm delete-segment-btn" style="padding: 8px 12px; display: flex; align-items: center; gap: 6px; flex-shrink: 0;">
				<span style="font-size: 16px;">🗑️</span>
				删除
			</button>
		`;
		
		// 删除按钮事件
		const deleteBtn = segmentEl.querySelector('.delete-segment-btn');
		if (deleteBtn) {
			deleteBtn.addEventListener('click', () => {
				if (confirm('确定要删除这个环节吗？')) {
					segmentEl.remove();
				}
			});
		}
		
		container.appendChild(segmentEl);
	});
}

console.log('✅ 后台管理系统事件处理器加载完成');

