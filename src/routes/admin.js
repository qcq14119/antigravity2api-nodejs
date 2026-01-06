import express from 'express';
import { generateToken, authMiddleware, verifyToken } from '../auth/jwt.js';
import tokenManager from '../auth/token_manager.js';
import quotaManager from '../auth/quota_manager.js';
import oauthManager from '../auth/oauth_manager.js';
import config, { getConfigJson, saveConfigJson } from '../config/config.js';
import logger from '../utils/logger.js';
import memoryManager from '../utils/memoryManager.js';
import { parseEnvFile, updateEnvFile } from '../utils/envParser.js';
import { reloadConfig } from '../utils/configReloader.js';
import { deepMerge } from '../utils/deepMerge.js';
import { getModelsWithQuotas } from '../api/client.js';
import { getEnvPath } from '../utils/paths.js';
import dotenv from 'dotenv';

const envPath = getEnvPath();

const router = express.Router();

// Cookie 配置
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  maxAge: 24 * 60 * 60 * 1000 // 24小时
};

// 从 Cookie 或 Header 获取 JWT Token 的中间件
const cookieAuthMiddleware = (req, res, next) => {
  // 优先从 Cookie 获取
  let token = req.cookies?.authToken;
  
  // 如果 Cookie 中没有，尝试从 Header 获取（兼容旧版本）
  if (!token) {
    const authHeader = req.headers.authorization;
    token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  }
  
  if (!token) {
    return res.status(401).json({ error: 'Token required' });
  }
  
  try {
    const decoded = verifyToken(token);
    req.user = decoded;
    next();
  } catch (error) {
    // 清除无效的 Cookie
    res.clearCookie('authToken');
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// 登录速率限制 - 防止暴力破解
const loginAttempts = new Map(); // IP -> { count, lastAttempt, blockedUntil }
const MAX_LOGIN_ATTEMPTS = 5;
const BLOCK_DURATION = 5 * 60 * 1000; // 5分钟
const ATTEMPT_WINDOW = 15 * 60 * 1000; // 15分钟窗口

function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
         req.headers['x-real-ip'] ||
         req.connection?.remoteAddress ||
         req.ip ||
         'unknown';
}

function checkLoginRateLimit(ip) {
  const now = Date.now();
  const attempt = loginAttempts.get(ip);
  
  if (!attempt) return { allowed: true };
  
  // 检查是否被封禁
  if (attempt.blockedUntil && now < attempt.blockedUntil) {
    const remainingSeconds = Math.ceil((attempt.blockedUntil - now) / 1000);
    return {
      allowed: false,
      message: `登录尝试过多，请 ${remainingSeconds} 秒后重试`,
      remainingSeconds
    };
  }
  
  // 清理过期的尝试记录
  if (now - attempt.lastAttempt > ATTEMPT_WINDOW) {
    loginAttempts.delete(ip);
    return { allowed: true };
  }
  
  return { allowed: true };
}

function recordLoginAttempt(ip, success) {
  const now = Date.now();
  
  if (success) {
    // 登录成功，清除记录
    loginAttempts.delete(ip);
    return;
  }
  
  // 登录失败，记录尝试
  const attempt = loginAttempts.get(ip) || { count: 0, lastAttempt: now };
  attempt.count++;
  attempt.lastAttempt = now;
  
  // 超过最大尝试次数，封禁
  if (attempt.count >= MAX_LOGIN_ATTEMPTS) {
    attempt.blockedUntil = now + BLOCK_DURATION;
    logger.warn(`IP ${ip} 因登录失败次数过多被暂时封禁`);
  }
  
  loginAttempts.set(ip, attempt);
}

// 登录接口
router.post('/login', (req, res) => {
  const clientIP = getClientIP(req);
  
  // 检查速率限制
  const rateCheck = checkLoginRateLimit(clientIP);
  if (!rateCheck.allowed) {
    return res.status(429).json({
      success: false,
      message: rateCheck.message,
      retryAfter: rateCheck.remainingSeconds
    });
  }
  
  const { username, password } = req.body;
  
  // 验证输入
  if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ success: false, message: '用户名和密码必填' });
  }
  
  // 限制输入长度防止 DoS
  if (username.length > 100 || password.length > 100) {
    return res.status(400).json({ success: false, message: '输入过长' });
  }
  
  if (username === config.admin.username && password === config.admin.password) {
    recordLoginAttempt(clientIP, true);
    const token = generateToken({ username, role: 'admin' });
    
    // 设置 HttpOnly Cookie
    res.cookie('authToken', token, COOKIE_OPTIONS);
    
    // 同时返回 token（兼容旧版本前端）
    res.json({ success: true, token });
  } else {
    recordLoginAttempt(clientIP, false);
    res.status(401).json({ success: false, message: '用户名或密码错误' });
  }
});

// 登出接口
router.post('/logout', (req, res) => {
  res.clearCookie('authToken');
  res.json({ success: true, message: '已登出' });
});

// 验证密码（用于敏感操作）
function verifyPassword(password) {
  return password === config.admin.password;
}

// Token管理API - 需要JWT认证（使用 Cookie 优先）
router.get('/tokens', cookieAuthMiddleware, async (req, res) => {
  try {
    const tokens = await tokenManager.getTokenList();
    res.json({ success: true, data: tokens });
  } catch (error) {
    logger.error('获取Token列表失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/tokens', cookieAuthMiddleware, async (req, res) => {
  const { access_token, refresh_token, expires_in, timestamp, enable, projectId, email } = req.body;
  if (!access_token || !refresh_token) {
    return res.status(400).json({ success: false, message: 'access_token和refresh_token必填' });
  }
  const tokenData = { access_token, refresh_token, expires_in };
  if (timestamp) tokenData.timestamp = timestamp;
  if (enable !== undefined) tokenData.enable = enable;
  if (projectId) tokenData.projectId = projectId;
  if (email) tokenData.email = email;
  
  try {
    const result = await tokenManager.addToken(tokenData);
    res.json(result);
  } catch (error) {
    logger.error('添加Token失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 使用 tokenId 替代 refreshToken
router.put('/tokens/:tokenId', cookieAuthMiddleware, async (req, res) => {
  const { tokenId } = req.params;
  const updates = req.body;
  
  // 不允许通过 API 更新敏感字段
  delete updates.access_token;
  delete updates.refresh_token;
  
  try {
    const result = await tokenManager.updateTokenById(tokenId, updates);
    res.json(result);
  } catch (error) {
    logger.error('更新Token失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.delete('/tokens/:tokenId', cookieAuthMiddleware, async (req, res) => {
  const { tokenId } = req.params;
  try {
    const result = await tokenManager.deleteTokenById(tokenId);
    res.json(result);
  } catch (error) {
    logger.error('删除Token失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/tokens/reload', cookieAuthMiddleware, async (req, res) => {
  try {
    await tokenManager.reload();
    res.json({ success: true, message: 'Token已热重载' });
  } catch (error) {
    logger.error('热重载失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 刷新指定Token的access_token（使用 tokenId）
router.post('/tokens/:tokenId/refresh', cookieAuthMiddleware, async (req, res) => {
  const { tokenId } = req.params;
  try {
    const result = await tokenManager.refreshTokenById(tokenId);
    res.json({ success: true, message: 'Token刷新成功', data: result });
  } catch (error) {
    logger.error('刷新Token失败:', error.message);
    const status = error.statusCode || 500;
    res.status(status).json({ success: false, message: error.message });
  }
});

// 导出所有 Token（需要密码验证）
router.post('/tokens/export', cookieAuthMiddleware, async (req, res) => {
  const { password } = req.body;
  
  if (!password || !verifyPassword(password)) {
    return res.status(403).json({ success: false, message: '密码验证失败' });
  }
  
  try {
    const allTokens = await tokenManager.store.readAll();
    
    // 导出格式：包含完整的 token 数据
    const exportData = {
      version: 1,
      exportTime: new Date().toISOString(),
      tokens: allTokens.map(token => ({
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        expires_in: token.expires_in,
        timestamp: token.timestamp,
        enable: token.enable,
        projectId: token.projectId,
        email: token.email,
        hasQuota: token.hasQuota
      }))
    };
    
    res.json({ success: true, data: exportData });
  } catch (error) {
    logger.error('导出Token失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 导入 Token（需要密码验证）
router.post('/tokens/import', cookieAuthMiddleware, async (req, res) => {
  const { password, data, mode = 'merge' } = req.body;
  
  if (!password || !verifyPassword(password)) {
    return res.status(403).json({ success: false, message: '密码验证失败' });
  }
  
  if (!data || !data.tokens || !Array.isArray(data.tokens)) {
    return res.status(400).json({ success: false, message: '无效的导入数据格式' });
  }
  
  try {
    const importTokens = data.tokens;
    let addedCount = 0;
    let skippedCount = 0;
    let updatedCount = 0;
    
    if (mode === 'replace') {
      // 替换模式：清空现有数据，导入新数据
      const validTokens = importTokens.filter(t => t.access_token && t.refresh_token);
      await tokenManager.store.writeAll(validTokens);
      addedCount = validTokens.length;
    } else {
      // 合并模式：根据 refresh_token 去重
      const existingTokens = await tokenManager.store.readAll();
      const existingRefreshTokens = new Set(existingTokens.map(t => t.refresh_token));
      
      for (const token of importTokens) {
        if (!token.access_token || !token.refresh_token) {
          skippedCount++;
          continue;
        }
        
        if (existingRefreshTokens.has(token.refresh_token)) {
          // 更新已存在的 token
          const index = existingTokens.findIndex(t => t.refresh_token === token.refresh_token);
          if (index !== -1) {
            existingTokens[index] = { ...existingTokens[index], ...token };
            updatedCount++;
          }
        } else {
          // 添加新 token
          existingTokens.push(token);
          addedCount++;
        }
      }
      
      await tokenManager.store.writeAll(existingTokens);
    }
    
    await tokenManager.reload();
    
    res.json({
      success: true,
      message: `导入完成：新增 ${addedCount} 个，更新 ${updatedCount} 个，跳过 ${skippedCount} 个`,
      data: { added: addedCount, updated: updatedCount, skipped: skippedCount }
    });
  } catch (error) {
    logger.error('导入Token失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/oauth/exchange', cookieAuthMiddleware, async (req, res) => {
  const { code, port } = req.body;
  if (!code || !port) {
    return res.status(400).json({ success: false, message: 'code和port必填' });
  }
  
  try {
    const account = await oauthManager.authenticate(code, port);
    const message = account.hasQuota 
      ? 'Token添加成功' 
      : 'Token添加成功（该账号无资格，已自动使用随机ProjectId）';
    res.json({ success: true, data: account, message, fallbackMode: !account.hasQuota });
  } catch (error) {
    logger.error('认证失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 获取配置
router.get('/config', cookieAuthMiddleware, (req, res) => {
  try {
    const envData = parseEnvFile(envPath);
    const jsonData = getConfigJson();
    res.json({ success: true, data: { env: envData, json: jsonData } });
  } catch (error) {
    logger.error('读取配置失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 更新配置
router.put('/config', cookieAuthMiddleware, (req, res) => {
  try {
    const { env: envUpdates, json: jsonUpdates } = req.body;
    
    if (envUpdates) updateEnvFile(envPath, envUpdates);
    if (jsonUpdates) saveConfigJson(deepMerge(getConfigJson(), jsonUpdates));
    
    dotenv.config({ override: true });
    reloadConfig();

    // 应用可热更新的运行时配置
    memoryManager.setCleanupInterval(config.server.memoryCleanupInterval);
    
    logger.info('配置已更新并热重载');
    res.json({ success: true, message: '配置已保存并生效（端口/HOST修改需重启）' });
  } catch (error) {
    logger.error('更新配置失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 获取轮询策略配置
router.get('/rotation', cookieAuthMiddleware, (req, res) => {
  try {
    const rotationConfig = tokenManager.getRotationConfig();
    res.json({ success: true, data: rotationConfig });
  } catch (error) {
    logger.error('获取轮询配置失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 更新轮询策略配置
router.put('/rotation', cookieAuthMiddleware, (req, res) => {
  try {
    const { strategy, requestCount } = req.body;
    
    // 验证策略值
    const validStrategies = ['round_robin', 'quota_exhausted', 'request_count'];
    if (strategy && !validStrategies.includes(strategy)) {
      return res.status(400).json({
        success: false,
        message: `无效的策略，可选值: ${validStrategies.join(', ')}`
      });
    }
    
    // 更新内存中的配置
    tokenManager.updateRotationConfig(strategy, requestCount);
    
    // 保存到config.json
    const currentConfig = getConfigJson();
    if (!currentConfig.rotation) currentConfig.rotation = {};
    if (strategy) currentConfig.rotation.strategy = strategy;
    if (requestCount) currentConfig.rotation.requestCount = requestCount;
    saveConfigJson(currentConfig);
    
    // 重载配置到内存
    reloadConfig();
    
    logger.info(`轮询策略已更新: ${strategy || '未变'}, 请求次数: ${requestCount || '未变'}`);
    res.json({ success: true, message: '轮询策略已更新', data: tokenManager.getRotationConfig() });
  } catch (error) {
    logger.error('更新轮询配置失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 获取指定Token的模型额度（使用 tokenId）
router.get('/tokens/:tokenId/quotas', cookieAuthMiddleware, async (req, res) => {
  try {
    const { tokenId } = req.params;
    const forceRefresh = req.query.refresh === 'true';
    
    // 通过 tokenId 查找完整的 token 数据
    let tokenData = await tokenManager.findTokenById(tokenId);
    
    if (!tokenData) {
      return res.status(404).json({ success: false, message: 'Token不存在' });
    }
    
    // 检查token是否过期，如果过期则刷新
    if (tokenManager.isExpired(tokenData)) {
      try {
        tokenData = await tokenManager.refreshToken(tokenData);
      } catch (error) {
        logger.error('刷新token失败:', error.message);
        // 使用 400 而不是 401，避免前端误认为 JWT 登录过期
        return res.status(400).json({ success: false, message: 'Google Token已过期且刷新失败，请重新登录Google账号' });
      }
    }
    
    // 使用 tokenId 作为缓存键
    let quotaData = forceRefresh ? null : quotaManager.getQuota(tokenId);
    
    if (!quotaData) {
      // 缓存未命中或强制刷新，从API获取
      const quotas = await getModelsWithQuotas(tokenData);
      quotaManager.updateQuota(tokenId, quotas);
      quotaData = { lastUpdated: Date.now(), models: quotas };
    }
    
    // 转换时间为北京时间
    const modelsWithBeijingTime = {};
    Object.entries(quotaData.models).forEach(([modelId, quota]) => {
      modelsWithBeijingTime[modelId] = {
        remaining: quota.r,
        resetTime: quotaManager.convertToBeijingTime(quota.t),
        resetTimeRaw: quota.t
      };
    });
    
    res.json({
      success: true,
      data: {
        lastUpdated: quotaData.lastUpdated,
        models: modelsWithBeijingTime
      }
    });
  } catch (error) {
    logger.error('获取额度失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
