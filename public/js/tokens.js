// Token管理：增删改查、启用禁用

let cachedTokens = [];
let currentFilter = localStorage.getItem('tokenFilter') || 'all'; // 'all', 'enabled', 'disabled'
let skipAnimation = false; // 是否跳过动画

// 移动端操作区手动收起/展开
let actionBarCollapsed = localStorage.getItem('actionBarCollapsed') === 'true';

// 导出 Token（需要密码验证）
async function exportTokens() {
    const password = await showPasswordPrompt('请输入管理员密码以导出 Token');
    if (!password) return;
    
    showLoading('正在导出...');
    try {
        const response = await authFetch('/admin/tokens/export', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password })
        });
        
        const data = await response.json();
        hideLoading();
        
        if (data.success) {
            // 创建下载
            const blob = new Blob([JSON.stringify(data.data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `tokens-export-${new Date().toISOString().slice(0, 10)}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            showToast('导出成功', 'success');
        } else {
            showToast(data.message || '导出失败', 'error');
        }
    } catch (error) {
        hideLoading();
        showToast('导出失败: ' + error.message, 'error');
    }
}

// 导入 Token（需要密码验证）
async function importTokens() {
    // 创建文件选择器
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        try {
            const text = await file.text();
            const importData = JSON.parse(text);
            
            // 验证数据格式
            if (!importData.tokens || !Array.isArray(importData.tokens)) {
                showToast('无效的导入文件格式', 'error');
                return;
            }
            
            // 显示导入选项
            showImportModal(importData);
        } catch (error) {
            showToast('读取文件失败: ' + error.message, 'error');
        }
    };
    
    input.click();
}

// 显示导入选项模态框
function showImportModal(importData) {
    const tokenCount = importData.tokens.length;
    const modal = document.createElement('div');
    modal.className = 'modal form-modal';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-title">📥 导入 Token</div>
            <p>文件包含 <strong>${tokenCount}</strong> 个 Token</p>
            <p style="font-size: 0.85rem; color: var(--text-light);">导出时间: ${importData.exportTime || '未知'}</p>
            <div class="form-group">
                <label>导入模式</label>
                <select id="importMode">
                    <option value="merge">合并（保留现有，添加新的）</option>
                    <option value="replace">替换（清空现有，导入新的）</option>
                </select>
            </div>
            <div class="form-group">
                <label>管理员密码</label>
                <input type="password" id="importPassword" placeholder="请输入管理员密码">
            </div>
            <div class="modal-actions">
                <button class="btn btn-secondary" onclick="this.closest('.modal').remove()">取消</button>
                <button class="btn btn-success" onclick="confirmImport(this)">✅ 确认导入</button>
            </div>
        </div>
    `;
    modal.dataset.importData = JSON.stringify(importData);
    document.body.appendChild(modal);
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
}

// 确认导入
async function confirmImport(btn) {
    const modal = btn.closest('.modal');
    const importData = JSON.parse(modal.dataset.importData);
    const mode = document.getElementById('importMode').value;
    const password = document.getElementById('importPassword').value;
    
    if (!password) {
        showToast('请输入密码', 'warning');
        return;
    }
    
    showLoading('正在导入...');
    try {
        const response = await authFetch('/admin/tokens/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password, data: importData, mode })
        });
        
        const data = await response.json();
        hideLoading();
        
        if (data.success) {
            modal.remove();
            showToast(data.message, 'success');
            loadTokens();
        } else {
            showToast(data.message || '导入失败', 'error');
        }
    } catch (error) {
        hideLoading();
        showToast('导入失败: ' + error.message, 'error');
    }
}

// 密码输入提示框
function showPasswordPrompt(message) {
    return new Promise((resolve) => {
        const modal = document.createElement('div');
        modal.className = 'modal form-modal';
        modal.innerHTML = `
            <div class="modal-content">
                <div class="modal-title">🔐 密码验证</div>
                <p>${message}</p>
                <div class="form-group">
                    <input type="password" id="promptPassword" placeholder="请输入密码">
                </div>
                <div class="modal-actions">
                    <button class="btn btn-secondary" onclick="this.closest('.modal').remove()">取消</button>
                    <button class="btn btn-success" id="promptConfirmBtn">确认</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        
        const passwordInput = document.getElementById('promptPassword');
        const confirmBtn = document.getElementById('promptConfirmBtn');
        
        confirmBtn.onclick = () => {
            const password = passwordInput.value;
            modal.remove();
            resolve(password || null);
        };
        
        passwordInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                confirmBtn.click();
            }
        });
        
        modal.onclick = (e) => {
            if (e.target === modal) {
                modal.remove();
                resolve(null);
            }
        };
        
        passwordInput.focus();
    });
}

// 手动切换操作区显示/隐藏（暴露到全局）
window.toggleActionBar = function() {
    const actionBar = document.getElementById('actionBar');
    const toggleBtn = document.getElementById('actionToggleBtn');
    
    if (!actionBar || !toggleBtn) return;
    
    actionBarCollapsed = !actionBarCollapsed;
    localStorage.setItem('actionBarCollapsed', actionBarCollapsed);
    
    if (actionBarCollapsed) {
        actionBar.classList.add('collapsed');
        toggleBtn.classList.add('collapsed');
        toggleBtn.title = '展开操作按钮';
    } else {
        actionBar.classList.remove('collapsed');
        toggleBtn.classList.remove('collapsed');
        toggleBtn.title = '收起操作按钮';
    }
}

// 初始化操作区状态（恢复保存的收起/展开状态）
function initActionBarState() {
    const actionBar = document.getElementById('actionBar');
    const toggleBtn = document.getElementById('actionToggleBtn');
    
    if (!actionBar || !toggleBtn) return;
    
    // 恢复保存的状态
    if (actionBarCollapsed) {
        actionBar.classList.add('collapsed');
        toggleBtn.classList.add('collapsed');
        toggleBtn.title = '展开操作按钮';
    }
}

// 页面加载后初始化
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initActionBarState);
} else {
    initActionBarState();
}

// 初始化筛选状态
function initFilterState() {
    const savedFilter = localStorage.getItem('tokenFilter') || 'all';
    currentFilter = savedFilter;
    updateFilterButtonState(savedFilter);
}

// 更新筛选按钮状态
function updateFilterButtonState(filter) {
    document.querySelectorAll('.stat-item').forEach(item => {
        item.classList.remove('active');
    });
    const filterMap = { 'all': 'totalTokens', 'enabled': 'enabledTokens', 'disabled': 'disabledTokens' };
    const activeElement = document.getElementById(filterMap[filter]);
    if (activeElement) {
        activeElement.closest('.stat-item').classList.add('active');
    }
}

// 筛选 Token
function filterTokens(filter) {
    currentFilter = filter;
    localStorage.setItem('tokenFilter', filter); // 持久化筛选状态
    
    updateFilterButtonState(filter);
    
    // 重新渲染
    renderTokens(cachedTokens);
}

async function loadTokens() {
    try {
        const response = await authFetch('/admin/tokens');
        
        const data = await response.json();
        if (data.success) {
            renderTokens(data.data);
        } else {
            showToast('加载失败: ' + (data.message || '未知错误'), 'error');
        }
    } catch (error) {
        showToast('加载Token失败: ' + error.message, 'error');
    }
}

// 正在刷新的 Token 集合（使用 tokenId）
const refreshingTokens = new Set();

function renderTokens(tokens) {
    // 只在首次加载时更新缓存
    if (tokens !== cachedTokens) {
        cachedTokens = tokens;
    }
    
    document.getElementById('totalTokens').textContent = tokens.length;
    document.getElementById('enabledTokens').textContent = tokens.filter(t => t.enable).length;
    document.getElementById('disabledTokens').textContent = tokens.filter(t => !t.enable).length;
    
    // 根据筛选条件过滤
    let filteredTokens = tokens;
    if (currentFilter === 'enabled') {
        filteredTokens = tokens.filter(t => t.enable);
    } else if (currentFilter === 'disabled') {
        filteredTokens = tokens.filter(t => !t.enable);
    }
    
    const tokenList = document.getElementById('tokenList');
    if (filteredTokens.length === 0) {
        const emptyText = currentFilter === 'all' ? '暂无Token' :
                          currentFilter === 'enabled' ? '暂无启用的Token' : '暂无禁用的Token';
        const emptyHint = currentFilter === 'all' ? '点击上方OAuth按钮添加Token' : '点击上方"总数"查看全部';
        tokenList.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">📦</div>
                <div class="empty-state-text">${emptyText}</div>
                <div class="empty-state-hint">${emptyHint}</div>
            </div>
        `;
        return;
    }
    
    tokenList.innerHTML = filteredTokens.map((token, index) => {
        // 使用安全的 tokenId 替代 refresh_token
        const tokenId = token.id;
        const isRefreshing = refreshingTokens.has(tokenId);
        const cardId = tokenId.substring(0, 8);
        
        // 计算在原始列表中的序号（基于添加顺序）
        const originalIndex = cachedTokens.findIndex(t => t.id === token.id);
        const tokenNumber = originalIndex + 1;
        
        // 转义所有用户数据防止 XSS
        const safeTokenId = escapeJs(tokenId);
        const safeProjectId = escapeHtml(token.projectId || '');
        const safeEmail = escapeHtml(token.email || '');
        const safeProjectIdJs = escapeJs(token.projectId || '');
        const safeEmailJs = escapeJs(token.email || '');
        
        return `
        <div class="token-card ${!token.enable ? 'disabled' : ''} ${isRefreshing ? 'refreshing' : ''} ${skipAnimation ? 'no-animation' : ''}" id="card-${escapeHtml(cardId)}">
            <div class="token-header">
                <div class="token-header-left">
                    <span class="status ${token.enable ? 'enabled' : 'disabled'}">
                        ${token.enable ? '✅ 启用' : '❌ 禁用'}
                    </span>
                    <button class="btn-icon token-refresh-btn ${isRefreshing ? 'loading' : ''}" id="refresh-btn-${escapeHtml(cardId)}" onclick="manualRefreshToken('${safeTokenId}')" title="刷新Token" ${isRefreshing ? 'disabled' : ''}>🔄</button>
                </div>
                <div class="token-header-right">
                    <button class="btn-icon" onclick="showTokenDetail('${safeTokenId}')" title="编辑">✏️</button>
                    <span class="token-id">#${tokenNumber}</span>
                </div>
            </div>
            <div class="token-info">
                <div class="info-row editable sensitive-row" onclick="editField(event, '${safeTokenId}', 'projectId', '${safeProjectIdJs}')" title="点击编辑">
                    <span class="info-label">📦</span>
                    <span class="info-value sensitive-info">${safeProjectId || '点击设置'}</span>
                    <span class="info-edit-icon">✏️</span>
                </div>
                <div class="info-row editable sensitive-row" onclick="editField(event, '${safeTokenId}', 'email', '${safeEmailJs}')" title="点击编辑">
                    <span class="info-label">📧</span>
                    <span class="info-value sensitive-info">${safeEmail || '点击设置'}</span>
                    <span class="info-edit-icon">✏️</span>
                </div>
            </div>
            <div class="token-quota-inline" id="quota-inline-${escapeHtml(cardId)}">
                <div class="quota-inline-header" onclick="toggleQuotaExpand('${escapeJs(cardId)}', '${safeTokenId}')">
                    <span class="quota-inline-summary" id="quota-summary-${escapeHtml(cardId)}">📊 加载中...</span>
                    <span class="quota-inline-toggle" id="quota-toggle-${escapeHtml(cardId)}">▼</span>
                </div>
                <div class="quota-inline-detail hidden" id="quota-detail-${escapeHtml(cardId)}"></div>
            </div>
            <div class="token-actions">
                <button class="btn btn-info btn-xs" onclick="showQuotaModal('${safeTokenId}')" title="查看额度">📊 详情</button>
                <button class="btn ${token.enable ? 'btn-warning' : 'btn-success'} btn-xs" onclick="toggleToken('${safeTokenId}', ${!token.enable})" title="${token.enable ? '禁用' : '启用'}">
                    ${token.enable ? '⏸️ 禁用' : '▶️ 启用'}
                </button>
                <button class="btn btn-danger btn-xs" onclick="deleteToken('${safeTokenId}')" title="删除">🗑️ 删除</button>
            </div>
        </div>
    `}).join('');
    
    filteredTokens.forEach(token => {
        loadTokenQuotaSummary(token.id);
    });
    
    updateSensitiveInfoDisplay();
    
    // 重置动画跳过标志
    skipAnimation = false;
}

// 手动刷新 Token（使用 tokenId）
async function manualRefreshToken(tokenId) {
    if (refreshingTokens.has(tokenId)) {
        showToast('该 Token 正在刷新中', 'warning');
        return;
    }
    await autoRefreshToken(tokenId);
}

// 刷新指定 Token（手动触发，使用 tokenId）
async function autoRefreshToken(tokenId) {
    if (refreshingTokens.has(tokenId)) return;
    
    refreshingTokens.add(tokenId);
    const cardId = tokenId.substring(0, 8);
    
    // 更新 UI 显示刷新中状态
    const card = document.getElementById(`card-${cardId}`);
    const refreshBtn = document.getElementById(`refresh-btn-${cardId}`);
    if (card) {
        card.classList.remove('refresh-failed');
        card.classList.add('refreshing');
    }
    if (refreshBtn) {
        refreshBtn.disabled = true;
        refreshBtn.classList.add('loading');
        refreshBtn.textContent = '🔄';
    }
    
    try {
        const response = await authFetch(`/admin/tokens/${encodeURIComponent(tokenId)}/refresh`, {
            method: 'POST'
        });
        
        const data = await response.json();
        if (data.success) {
            showToast('Token 已自动刷新', 'success');
            // 刷新成功后重新加载列表
            refreshingTokens.delete(tokenId);
            if (card) card.classList.remove('refreshing');
            if (refreshBtn) {
                refreshBtn.disabled = false;
                refreshBtn.classList.remove('loading');
                refreshBtn.textContent = '🔄';
            }
            loadTokens();
        } else {
            showToast(`Token 刷新失败: ${data.message || '未知错误'}`, 'error');
            refreshingTokens.delete(tokenId);
            // 更新 UI 显示刷新失败
            if (card) {
                card.classList.remove('refreshing');
                card.classList.add('refresh-failed');
            }
            if (refreshBtn) {
                refreshBtn.disabled = false;
                refreshBtn.classList.remove('loading');
                refreshBtn.textContent = '🔄';
            }
        }
    } catch (error) {
        if (error.message !== 'Unauthorized') {
            showToast(`Token 刷新失败: ${error.message}`, 'error');
        }
        refreshingTokens.delete(tokenId);
        // 更新 UI 显示刷新失败
        if (card) {
            card.classList.remove('refreshing');
            card.classList.add('refresh-failed');
        }
        if (refreshBtn) {
            refreshBtn.disabled = false;
            refreshBtn.classList.remove('loading');
            refreshBtn.textContent = '🔄';
        }
    }
}

function showManualModal() {
    const modal = document.createElement('div');
    modal.className = 'modal form-modal';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-title">✏️ 手动填入Token</div>
            <div class="form-row">
                <input type="text" id="modalAccessToken" placeholder="Access Token (必填)">
                <input type="text" id="modalRefreshToken" placeholder="Refresh Token (必填)">
                <input type="number" id="modalExpiresIn" placeholder="有效期(秒)" value="3599">
            </div>
            <p style="font-size: 0.8rem; color: var(--text-light); margin-bottom: 12px;">💡 有效期默认3599秒(约1小时)</p>
            <div class="modal-actions">
                <button class="btn btn-secondary" onclick="this.closest('.modal').remove()">取消</button>
                <button class="btn btn-success" onclick="addTokenFromModal()">✅ 添加</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
}

async function addTokenFromModal() {
    const modal = document.querySelector('.form-modal');
    const accessToken = document.getElementById('modalAccessToken').value.trim();
    const refreshToken = document.getElementById('modalRefreshToken').value.trim();
    const expiresIn = parseInt(document.getElementById('modalExpiresIn').value);
    
    if (!accessToken || !refreshToken) {
        showToast('请填写完整的Token信息', 'warning');
        return;
    }
    
    showLoading('正在添加Token...');
    try {
        const response = await authFetch('/admin/tokens', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn })
        });
        
        const data = await response.json();
        hideLoading();
        if (data.success) {
            modal.remove();
            showToast('Token添加成功', 'success');
            loadTokens();
        } else {
            showToast(data.message || '添加失败', 'error');
        }
    } catch (error) {
        hideLoading();
        showToast('添加失败: ' + error.message, 'error');
    }
}

function editField(event, tokenId, field, currentValue) {
    event.stopPropagation();
    const row = event.currentTarget;
    const valueSpan = row.querySelector('.info-value');
    
    if (row.querySelector('input')) return;
    
    const fieldLabels = { projectId: 'Project ID', email: '邮箱' };
    
    const input = document.createElement('input');
    input.type = field === 'email' ? 'email' : 'text';
    input.value = currentValue;
    input.className = 'inline-edit-input';
    input.placeholder = `输入${fieldLabels[field]}`;
    
    valueSpan.style.display = 'none';
    row.insertBefore(input, valueSpan.nextSibling);
    input.focus();
    input.select();
    
    const save = async () => {
        const newValue = input.value.trim();
        input.disabled = true;
        
        try {
            const response = await authFetch(`/admin/tokens/${encodeURIComponent(tokenId)}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ [field]: newValue })
            });
            
            const data = await response.json();
            if (data.success) {
                showToast('已保存', 'success');
                loadTokens();
            } else {
                showToast(data.message || '保存失败', 'error');
                cancel();
            }
        } catch (error) {
            showToast('保存失败', 'error');
            cancel();
        }
    };
    
    const cancel = () => {
        input.remove();
        valueSpan.style.display = '';
    };
    
    input.addEventListener('blur', () => {
        setTimeout(() => {
            if (document.activeElement !== input) {
                if (input.value.trim() !== currentValue) {
                    save();
                } else {
                    cancel();
                }
            }
        }, 100);
    });
    
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            save();
        } else if (e.key === 'Escape') {
            cancel();
        }
    });
}

function showTokenDetail(tokenId) {
    const token = cachedTokens.find(t => t.id === tokenId);
    if (!token) {
        showToast('Token不存在', 'error');
        return;
    }
    
    // 转义所有用户数据防止 XSS
    const safeTokenId = escapeJs(tokenId);
    const safeProjectId = escapeHtml(token.projectId || '');
    const safeEmail = escapeHtml(token.email || '');
    const updatedAtStr = escapeHtml(token.timestamp ? new Date(token.timestamp).toLocaleString('zh-CN') : '未知');
    
    const modal = document.createElement('div');
    modal.className = 'modal form-modal';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-title">📝 Token详情</div>
            <div class="form-group compact">
                <label>🔑 Token ID</label>
                <div class="token-display">${escapeHtml(tokenId)}</div>
            </div>
            <div class="form-group compact">
                <label>📦 Project ID</label>
                <input type="text" id="editProjectId" value="${safeProjectId}" placeholder="项目ID">
            </div>
            <div class="form-group compact">
                <label>📧 邮箱</label>
                <input type="email" id="editEmail" value="${safeEmail}" placeholder="账号邮箱">
            </div>
            <div class="form-group compact">
                <label>🕒 最后更新时间</label>
                <input type="text" value="${updatedAtStr}" readonly style="background: var(--bg); cursor: not-allowed;">
            </div>
            <div class="modal-actions">
                <button class="btn btn-secondary" onclick="this.closest('.modal').remove()">取消</button>
                <button class="btn btn-success" onclick="saveTokenDetail('${safeTokenId}')">💾 保存</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
}

async function saveTokenDetail(tokenId) {
    const projectId = document.getElementById('editProjectId').value.trim();
    const email = document.getElementById('editEmail').value.trim();
    
    showLoading('保存中...');
    try {
        const response = await authFetch(`/admin/tokens/${encodeURIComponent(tokenId)}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ projectId, email })
        });
        
        const data = await response.json();
        hideLoading();
        if (data.success) {
            document.querySelector('.form-modal').remove();
            showToast('保存成功', 'success');
            loadTokens();
        } else {
            showToast(data.message || '保存失败', 'error');
        }
    } catch (error) {
        hideLoading();
        showToast('保存失败: ' + error.message, 'error');
    }
}

async function toggleToken(tokenId, enable) {
    const action = enable ? '启用' : '禁用';
    const confirmed = await showConfirm(`确定要${action}这个Token吗？`, `${action}确认`);
    if (!confirmed) return;
    
    showLoading(`正在${action}...`);
    try {
        const response = await authFetch(`/admin/tokens/${encodeURIComponent(tokenId)}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ enable })
        });
        
        const data = await response.json();
        hideLoading();
        if (data.success) {
            showToast(`已${action}`, 'success');
            skipAnimation = true; // 跳过动画
            loadTokens();
        } else {
            showToast(data.message || '操作失败', 'error');
        }
    } catch (error) {
        hideLoading();
        showToast('操作失败: ' + error.message, 'error');
    }
}

async function deleteToken(tokenId) {
    const confirmed = await showConfirm('删除后无法恢复，确定删除？', '⚠️ 删除确认');
    if (!confirmed) return;
    
    showLoading('正在删除...');
    try {
        const response = await authFetch(`/admin/tokens/${encodeURIComponent(tokenId)}`, {
            method: 'DELETE'
        });
        
        const data = await response.json();
        hideLoading();
        if (data.success) {
            showToast('已删除', 'success');
            loadTokens();
        } else {
            showToast(data.message || '删除失败', 'error');
        }
    } catch (error) {
        hideLoading();
        showToast('删除失败: ' + error.message, 'error');
    }
}
