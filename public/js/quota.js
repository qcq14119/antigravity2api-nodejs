// 额度管理：查看、刷新、缓存

let currentQuotaToken = null;

const quotaCache = {
    data: {},
    ttl: 5 * 60 * 1000,
    
    get(tokenId) {
        const cached = this.data[tokenId];
        if (!cached) return null;
        if (Date.now() - cached.timestamp > this.ttl) {
            delete this.data[tokenId];
            return null;
        }
        return cached.data;
    },
    
    set(tokenId, data) {
        this.data[tokenId] = { data, timestamp: Date.now() };
    },
    
    clear(tokenId) {
        if (tokenId) {
            delete this.data[tokenId];
        } else {
            this.data = {};
        }
    }
};

const QUOTA_GROUPS = [
    {
        key: 'claude',
        label: 'Claude',
        iconSrc: '/assets/icons/claude.svg',
        match: (modelId) => modelId.toLowerCase().includes('claude')
    },
    {
        key: 'banana',
        label: 'banana',
        iconSrc: '/assets/icons/banana.svg',
        match: (modelId) => modelId.toLowerCase().includes('gemini-3-pro-image')
    },
    {
        key: 'gemini',
        label: 'Gemini',
        iconSrc: '/assets/icons/gemini.svg',
        match: (modelId) => modelId.toLowerCase().includes('gemini') || modelId.toLowerCase().includes('publishers/google/')
    },
    {
        key: 'other',
        label: '其他',
        iconSrc: '',
        match: () => true
    }
];

const QUOTA_SUMMARY_KEYS = ['claude', 'gemini', 'banana'];

function getGroupIconHtml(group) {
    const src = group?.iconSrc || '';
    const alt = escapeHtml(group?.label || '');
    const safeSrc = escapeHtml(src);
    if (!safeSrc) return '';
    return `<img class="quota-icon-img" src="${safeSrc}" alt="${alt}" loading="lazy" decoding="async">`;
}

function clamp01(value) {
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue)) return 0;
    return Math.min(1, Math.max(0, numberValue));
}

function toPercentage(fraction01) {
    return clamp01(fraction01) * 100;
}

function formatPercentage(fraction01) {
    return `${toPercentage(fraction01).toFixed(2)}%`;
}

function getBarColor(percentage) {
    if (percentage > 50) return '#10b981';
    if (percentage > 20) return '#f59e0b';
    return '#ef4444';
}

function groupModels(models) {
    const grouped = { claude: [], gemini: [], banana: [], other: [] };

    Object.entries(models || {}).forEach(([modelId, quota]) => {
        const groupKey = (QUOTA_GROUPS.find(g => g.match(modelId)) || QUOTA_GROUPS[QUOTA_GROUPS.length - 1]).key;
        if (!grouped[groupKey]) grouped[groupKey] = [];
        grouped[groupKey].push({ modelId, quota });
    });

    return grouped;
}

function summarizeGroup(items) {
    if (!items || items.length === 0) {
        return { percentage: 0, percentageText: '--', resetTime: '--' };
    }

    let minRemaining = 1;
    let earliestResetMs = null;
    let earliestResetText = null;

    items.forEach(({ quota }) => {
        const remaining = clamp01(quota?.remaining);
        if (remaining < minRemaining) minRemaining = remaining;

        const resetRaw = quota?.resetTimeRaw;
        const resetText = quota?.resetTime;

        if (resetRaw) {
            const ms = Date.parse(resetRaw);
            if (Number.isFinite(ms) && (earliestResetMs === null || ms < earliestResetMs)) {
                earliestResetMs = ms;
                earliestResetText = resetText || null;
            }
        } else if (!earliestResetText && resetText) {
            earliestResetText = resetText;
        }
    });

    return {
        percentage: toPercentage(minRemaining),
        percentageText: formatPercentage(minRemaining),
        resetTime: earliestResetText || '--'
    };
}

// 使用 tokenId 加载额度摘要
async function loadTokenQuotaSummary(tokenId) {
    const cardId = tokenId.substring(0, 8);
    const summaryEl = document.getElementById(`quota-summary-${cardId}`);
    if (!summaryEl) return;
    
    const cached = quotaCache.get(tokenId);
    if (cached) {
        renderQuotaSummary(summaryEl, cached);
        return;
    }
    
    try {
        const response = await authFetch(`/admin/tokens/${encodeURIComponent(tokenId)}/quotas`);
        const data = await response.json();
        
        if (data.success && data.data && data.data.models) {
            quotaCache.set(tokenId, data.data);
            renderQuotaSummary(summaryEl, data.data);
        } else {
            const errMsg = escapeHtml(data.message || '未知错误');
            summaryEl.innerHTML = `<span class="quota-summary-error">📊 ${errMsg}</span>`;
        }
    } catch (error) {
        if (error.message !== 'Unauthorized') {
            console.error('加载额度摘要失败:', error);
            summaryEl.innerHTML = `<span class="quota-summary-error">📊 加载失败</span>`;
        }
    }
}

function renderQuotaSummary(summaryEl, quotaData) {
    const models = quotaData.models;
    const modelEntries = Object.entries(models || {});
    
    if (modelEntries.length === 0) {
        summaryEl.textContent = '📊 暂无额度';
        return;
    }
    
    const grouped = groupModels(models);
    const groupByKey = Object.fromEntries(QUOTA_GROUPS.map(g => [g.key, g]));

    const rowsHtml = QUOTA_SUMMARY_KEYS.map((groupKey) => {
        const group = groupByKey[groupKey];
        const summary = summarizeGroup(grouped[groupKey]);
        const barColor = summary.percentageText === '--' ? '#9ca3af' : getBarColor(summary.percentage);
        const safeResetTime = escapeHtml(summary.resetTime);
        const resetText = safeResetTime === '--' ? '--' : `重置: ${safeResetTime}`;
        const safeLabel = escapeHtml(group?.label || groupKey);
        const title = `${group?.label || groupKey} - 重置: ${summary.resetTime}`;
        return `
            <div class="quota-summary-row" title="${escapeHtml(title)}">
                <span class="quota-summary-icon">${getGroupIconHtml(group)}</span>
                <span class="quota-summary-label">${safeLabel}</span>
                <span class="quota-summary-bar"><span style="width:${summary.percentage}%;background:${barColor}"></span></span>
                <span class="quota-summary-pct">${summary.percentageText}</span>
                <span class="quota-summary-reset">${resetText}</span>
            </div>
        `;
    }).join('');

    summaryEl.innerHTML = `
        <div class="quota-summary-grid">
            ${rowsHtml}
        </div>
    `;
}

async function toggleQuotaExpand(cardId, tokenId) {
    const detailEl = document.getElementById(`quota-detail-${cardId}`);
    const toggleEl = document.getElementById(`quota-toggle-${cardId}`);
    if (!detailEl || !toggleEl) return;
    
    const isHidden = detailEl.classList.contains('hidden');
    
    if (isHidden) {
        detailEl.classList.remove('hidden');
        detailEl.classList.remove('collapsing');
        toggleEl.classList.add('expanded');
        
        if (!detailEl.dataset.loaded) {
            detailEl.innerHTML = '<div class="quota-loading-small">加载中...</div>';
            await loadQuotaDetail(cardId, tokenId);
            detailEl.dataset.loaded = 'true';
        }
    } else {
        // 添加收起动画
        detailEl.classList.add('collapsing');
        toggleEl.classList.remove('expanded');
        
        // 动画结束后隐藏
        setTimeout(() => {
            detailEl.classList.add('hidden');
            detailEl.classList.remove('collapsing');
        }, 200);
    }
}

async function loadQuotaDetail(cardId, tokenId) {
    const detailEl = document.getElementById(`quota-detail-${cardId}`);
    if (!detailEl) return;
    
    try {
        const response = await authFetch(`/admin/tokens/${encodeURIComponent(tokenId)}/quotas`);
        const data = await response.json();
        
        if (data.success && data.data && data.data.models) {
            const models = data.data.models;
            const modelEntries = Object.entries(models);
            
            if (modelEntries.length === 0) {
                detailEl.innerHTML = '<div class="quota-empty-small">暂无额度信息</div>';
                return;
            }
            
            const grouped = groupModels(models);
            
            let html = '<div class="quota-detail-grid">';
            
            const renderGroup = (items, icon) => {
                if (items.length === 0) return '';
                let groupHtml = '';
                items.forEach(({ modelId, quota }) => {
                    const percentage = toPercentage(quota?.remaining);
                    const percentageText = formatPercentage(quota?.remaining);
                    const barColor = getBarColor(percentage);
                    const shortName = escapeHtml(modelId.replace('models/', '').replace('publishers/google/', '').split('/').pop());
                    const safeModelId = escapeHtml(modelId);
                    const safeResetTime = escapeHtml(quota.resetTime);
                    groupHtml += `
                        <div class="quota-detail-row" title="${safeModelId} - 重置: ${safeResetTime}">
                            <span class="quota-detail-icon">${icon}</span>
                            <span class="quota-detail-name">${shortName}</span>
                            <span class="quota-detail-bar"><span style="width:${percentage}%;background:${barColor}"></span></span>
                            <span class="quota-detail-pct">${percentageText}</span>
                        </div>
                    `;
                });
                return groupHtml;
            };
            
            const groupByKey = Object.fromEntries(QUOTA_GROUPS.map(g => [g.key, g]));
            html += renderGroup(grouped.claude, getGroupIconHtml(groupByKey.claude));
            html += renderGroup(grouped.gemini, getGroupIconHtml(groupByKey.gemini));
            html += renderGroup(grouped.banana, getGroupIconHtml(groupByKey.banana));
            html += renderGroup(grouped.other, '');
            html += '</div>';
            html += `<button class="btn btn-info btn-xs quota-refresh-btn" onclick="refreshInlineQuota('${escapeJs(cardId)}', '${escapeJs(tokenId)}')">🔄 刷新额度</button>`;
            
            detailEl.innerHTML = html;
        } else {
            const errMsg = escapeHtml(data.message || '未知错误');
            detailEl.innerHTML = `<div class="quota-error-small">加载失败: ${errMsg}</div>`;
        }
    } catch (error) {
        if (error.message !== 'Unauthorized') {
            detailEl.innerHTML = `<div class="quota-error-small">网络错误</div>`;
        }
    }
}

async function refreshInlineQuota(cardId, tokenId) {
    const detailEl = document.getElementById(`quota-detail-${cardId}`);
    const summaryEl = document.getElementById(`quota-summary-${cardId}`);
    
    if (detailEl) detailEl.innerHTML = '<div class="quota-loading-small">刷新中...</div>';
    if (summaryEl) summaryEl.textContent = '📊 刷新中...';
    
    quotaCache.clear(tokenId);
    
    try {
        const response = await authFetch(`/admin/tokens/${encodeURIComponent(tokenId)}/quotas?refresh=true`);
        const data = await response.json();
        if (data.success && data.data) {
            quotaCache.set(tokenId, data.data);
        }
    } catch (e) {}
    
    await loadTokenQuotaSummary(tokenId);
    await loadQuotaDetail(cardId, tokenId);
}

// 存储当前弹窗的事件处理器引用，便于清理
let quotaModalWheelHandler = null;

async function showQuotaModal(tokenId) {
    currentQuotaToken = tokenId;
    
    const activeIndex = cachedTokens.findIndex(t => t.id === tokenId);
    
    const emailTabs = cachedTokens.map((t, index) => {
        const email = t.email || '未知';
        const shortEmail = email.length > 20 ? email.substring(0, 17) + '...' : email;
        const isActive = index === activeIndex;
        const safeEmail = escapeHtml(email);
        const safeShortEmail = escapeHtml(shortEmail);
        return `<button type="button" class="quota-tab${isActive ? ' active' : ''}" data-index="${index}" onclick="switchQuotaAccountByIndex(${index})" title="${safeEmail}">${safeShortEmail}</button>`;
    }).join('');
    
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'quotaModal';
    modal.innerHTML = `
        <div class="modal-content modal-xl">
            <div class="quota-modal-header">
                <div class="modal-title">📊 模型额度</div>
                <div class="quota-update-time" id="quotaUpdateTime"></div>
            </div>
            <div class="quota-tabs" id="quotaEmailList">
                ${emailTabs}
            </div>
            <div id="quotaContent" class="quota-container">
                <div class="quota-loading">加载中...</div>
            </div>
            <div class="modal-actions">
                <button class="btn btn-secondary btn-sm" onclick="closeQuotaModal()">关闭</button>
                <button class="btn btn-info btn-sm" id="quotaRefreshBtn" onclick="refreshQuotaData()">🔄 刷新</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    
    // 关闭弹窗时清理事件监听器
    modal.onclick = (e) => {
        if (e.target === modal) {
            closeQuotaModal();
        }
    };
    
    await loadQuotaData(tokenId);
    
    const tabsContainer = document.getElementById('quotaEmailList');
    if (tabsContainer) {
        // 创建事件处理器并保存引用
        quotaModalWheelHandler = (e) => {
            if (e.deltaY !== 0) {
                e.preventDefault();
                tabsContainer.scrollLeft += e.deltaY;
            }
        };
        tabsContainer.addEventListener('wheel', quotaModalWheelHandler, { passive: false });
    }
}

// 关闭额度弹窗并清理事件监听器
function closeQuotaModal() {
    const modal = document.getElementById('quotaModal');
    
    // 清理滚轮事件监听器
    if (quotaModalWheelHandler) {
        const tabsContainer = document.getElementById('quotaEmailList');
        if (tabsContainer) {
            tabsContainer.removeEventListener('wheel', quotaModalWheelHandler);
        }
        quotaModalWheelHandler = null;
    }
    
    if (modal) {
        modal.remove();
    }
    
    currentQuotaToken = null;
}

async function switchQuotaAccountByIndex(index) {
    if (index < 0 || index >= cachedTokens.length) return;
    
    const token = cachedTokens[index];
    currentQuotaToken = token.id;
    
    document.querySelectorAll('.quota-tab').forEach((tab, i) => {
        if (i === index) {
            tab.classList.add('active');
        } else {
            tab.classList.remove('active');
        }
    });
    
    await loadQuotaData(token.id);
}

async function switchQuotaAccount(tokenId) {
    const index = cachedTokens.findIndex(t => t.id === tokenId);
    if (index >= 0) {
        await switchQuotaAccountByIndex(index);
    }
}

async function loadQuotaData(tokenId, forceRefresh = false) {
    const quotaContent = document.getElementById('quotaContent');
    if (!quotaContent) return;
    
    const refreshBtn = document.getElementById('quotaRefreshBtn');
    if (refreshBtn) {
        refreshBtn.disabled = true;
        refreshBtn.textContent = '⏳ 加载中...';
    }
    
    if (!forceRefresh) {
        const cached = quotaCache.get(tokenId);
        if (cached) {
            renderQuotaModal(quotaContent, cached);
            if (refreshBtn) {
                refreshBtn.disabled = false;
                refreshBtn.textContent = '🔄 刷新';
            }
            return;
        }
    } else {
        quotaCache.clear(tokenId);
    }
    
    quotaContent.innerHTML = '<div class="quota-loading">加载中...</div>';
    
    try {
        const url = `/admin/tokens/${encodeURIComponent(tokenId)}/quotas${forceRefresh ? '?refresh=true' : ''}`;
        const response = await authFetch(url);
        
        const data = await response.json();
        
        if (data.success) {
            quotaCache.set(tokenId, data.data);
            renderQuotaModal(quotaContent, data.data);
        } else {
            quotaContent.innerHTML = `<div class="quota-error">加载失败: ${escapeHtml(data.message)}</div>`;
        }
    } catch (error) {
        if (quotaContent) {
            quotaContent.innerHTML = `<div class="quota-error">加载失败: ${escapeHtml(error.message)}</div>`;
        }
    } finally {
        if (refreshBtn) {
            refreshBtn.disabled = false;
            refreshBtn.textContent = '🔄 刷新';
        }
    }
}

async function refreshQuotaData() {
    if (currentQuotaToken) {
        await loadQuotaData(currentQuotaToken, true);
    }
}

// 刷新所有 Token 的额度数据
async function refreshAllQuotas() {
    if (!cachedTokens || cachedTokens.length === 0) {
        showToast('没有可刷新的 Token', 'warning');
        return;
    }
    
    const btn = document.getElementById('refreshQuotasBtn');
    if (btn) {
        btn.disabled = true;
        btn.textContent = '⏳ 刷新中...';
    }
    
    // 清除所有前端缓存
    quotaCache.clear();
    
    try {
        // 并行刷新所有 Token 的额度
        const refreshPromises = cachedTokens.map(async (token) => {
            try {
                const response = await authFetch(`/admin/tokens/${encodeURIComponent(token.id)}/quotas?refresh=true`);
                const data = await response.json();
                if (data.success && data.data) {
                    quotaCache.set(token.id, data.data);
                }
            } catch (e) {
                // 单个 Token 刷新失败不影响其他
                console.error(`刷新 Token ${token.email || token.id.substring(0, 8)} 额度失败:`, e);
            }
        });
        
        await Promise.all(refreshPromises);
        
        // 重新渲染所有额度摘要
        cachedTokens.forEach(token => {
            loadTokenQuotaSummary(token.id);
        });
        
        showToast('所有额度已刷新', 'success');
    } catch (error) {
        showToast('刷新额度失败: ' + error.message, 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = '📊 刷新额度';
        }
    }
}

function renderQuotaModal(quotaContent, quotaData) {
    const models = quotaData.models;
    
    const updateTimeEl = document.getElementById('quotaUpdateTime');
    if (updateTimeEl && quotaData.lastUpdated) {
        const lastUpdated = new Date(quotaData.lastUpdated).toLocaleString('zh-CN', {
            month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
        });
        updateTimeEl.textContent = `更新于 ${lastUpdated}`;
    }
    
    if (Object.keys(models).length === 0) {
        quotaContent.innerHTML = '<div class="quota-empty">暂无额度信息</div>';
        return;
    }
    
    const grouped = groupModels(models);
    
    let html = '';
    
    const renderGroup = (items, group) => {
        const summary = summarizeGroup(items);
        const safeLabel = escapeHtml(group.label);
        const safeResetTime = escapeHtml(summary.resetTime);
        const iconHtml = getGroupIconHtml(group);
        let groupHtml = `
            <div class="quota-group-title">
                <span class="quota-group-left">
                    <span class="quota-group-icon">${iconHtml}</span>
                    <span class="quota-group-label">${safeLabel}</span>
                </span>
                <span class="quota-group-meta">${escapeHtml(summary.percentageText)} · 重置: ${safeResetTime}</span>
            </div>
        `;

        if (items.length === 0) {
            groupHtml += '<div class="quota-empty-small">暂无</div>';
            return groupHtml;
        }

        groupHtml += '<div class="quota-grid">';
        items.forEach(({ modelId, quota }) => {
            const percentage = toPercentage(quota?.remaining);
            const percentageText = formatPercentage(quota?.remaining);
            const barColor = getBarColor(percentage);
            const shortName = escapeHtml(modelId.replace('models/', '').replace('publishers/google/', ''));
            const safeModelId = escapeHtml(modelId);
            const safeResetTime = escapeHtml(quota.resetTime);
            groupHtml += `
                <div class="quota-item">
                    <div class="quota-model-name" title="${safeModelId}">
                        <span class="quota-model-icon">${iconHtml}</span>
                        <span class="quota-model-text">${shortName}</span>
                    </div>
                    <div class="quota-bar-container">
                        <div class="quota-bar" style="width: ${percentage}%; background: ${barColor};"></div>
                    </div>
                    <div class="quota-info-row">
                        <span class="quota-reset">重置: ${safeResetTime}</span>
                        <span class="quota-percentage">${percentageText}</span>
                    </div>
                </div>
            `;
        });
        groupHtml += '</div>';
        return groupHtml;
    };
    
    const groupByKey = Object.fromEntries(QUOTA_GROUPS.map(g => [g.key, g]));
    html += renderGroup(grouped.claude, groupByKey.claude);
    html += renderGroup(grouped.gemini, groupByKey.gemini);
    html += renderGroup(grouped.banana, groupByKey.banana);
    if (grouped.other && grouped.other.length > 0) {
        html += renderGroup(grouped.other, groupByKey.other);
    }
    
    quotaContent.innerHTML = html;
}
