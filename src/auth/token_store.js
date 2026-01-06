import fs from 'fs/promises';
import path from 'path';
import { getDataDir } from '../utils/paths.js';
import { FILE_CACHE_TTL } from '../constants/index.js';
import { log } from '../utils/logger.js';
import { generateSalt } from '../utils/idGenerator.js';

/**
 * 账号数据文件结构：
 * {
 *   "salt": "随机盐值，用于生成安全的tokenId",
 *   "tokens": [...]
 * }
 */

/**
 * 负责 token 文件的读写与简单缓存
 * 不关心业务字段，只处理 JSON 数组的加载和保存
 */
class TokenStore {
  constructor(filePath = path.join(getDataDir(), 'accounts.json')) {
    this.filePath = filePath;
    this._cache = null;
    this._cacheTime = 0;
    this._cacheTTL = FILE_CACHE_TTL;
    this._salt = null;
  }

  async _ensureFileExists() {
    const dir = path.dirname(this.filePath);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (e) {
      // 目录已存在等情况忽略
    }

    try {
      await fs.access(this.filePath);
    } catch (e) {
      // 文件不存在时创建带盐值的空结构
      const initialData = {
        salt: generateSalt(),
        tokens: []
      };
      await fs.writeFile(this.filePath, JSON.stringify(initialData, null, 2), 'utf8');
      log.info('✓ 已创建账号配置文件（含安全盐值）');
    }
  }

  /**
   * 获取盐值（用于生成安全的 tokenId）
   * @returns {Promise<string>} 盐值
   */
  async getSalt() {
    if (this._salt) return this._salt;
    
    await this._ensureFileExists();
    try {
      const data = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(data || '{}');
      
      // 兼容旧格式：如果是数组，迁移到新格式
      if (Array.isArray(parsed)) {
        const newData = {
          salt: generateSalt(),
          tokens: parsed
        };
        await fs.writeFile(this.filePath, JSON.stringify(newData, null, 2), 'utf8');
        log.info('✓ 已迁移账号配置文件到新格式（添加安全盐值）');
        this._salt = newData.salt;
        return this._salt;
      }
      
      // 如果没有盐值，生成一个
      if (!parsed.salt) {
        parsed.salt = generateSalt();
        parsed.tokens = parsed.tokens || [];
        await fs.writeFile(this.filePath, JSON.stringify(parsed, null, 2), 'utf8');
        log.info('✓ 已为账号配置文件添加安全盐值');
      }
      
      this._salt = parsed.salt;
      return this._salt;
    } catch (error) {
      log.error('读取盐值失败:', error.message);
      // 生成临时盐值
      this._salt = generateSalt();
      return this._salt;
    }
  }

  _isCacheValid() {
    if (!this._cache) return false;
    const now = Date.now();
    return (now - this._cacheTime) < this._cacheTTL;
  }

  /**
   * 读取全部 token（包含禁用的），带简单内存缓存
   * @returns {Promise<Array<object>>}
   */
  async readAll() {
    if (this._isCacheValid()) {
      return this._cache;
    }

    await this._ensureFileExists();
    try {
      const data = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(data || '{}');
      
      // 兼容旧格式：如果是数组，直接使用
      if (Array.isArray(parsed)) {
        this._cache = parsed;
      } else if (parsed.tokens && Array.isArray(parsed.tokens)) {
        this._cache = parsed.tokens;
      } else {
        log.warn('账号配置文件格式异常，已重置为空数组');
        this._cache = [];
      }
    } catch (error) {
      log.error('读取账号配置文件失败:', error.message);
      this._cache = [];
    }
    this._cacheTime = Date.now();
    return this._cache;
  }

  /**
   * 覆盖写入全部 token，更新缓存
   * @param {Array<object>} tokens
   */
  async writeAll(tokens) {
    await this._ensureFileExists();
    const normalized = Array.isArray(tokens) ? tokens : [];
    
    // 确保盐值已加载
    const salt = await this.getSalt();
    
    try {
      const fileData = {
        salt: salt,
        tokens: normalized
      };
      await fs.writeFile(this.filePath, JSON.stringify(fileData, null, 2), 'utf8');
      this._cache = normalized;
      this._cacheTime = Date.now();
    } catch (error) {
      log.error('保存账号配置文件失败:', error.message);
      throw error;
    }
  }

  /**
   * 根据内存中的启用 token 列表，将对应记录合并回文件
   * - 仅按 refresh_token 匹配并更新已有记录
   * - 未出现在 activeTokens 中的记录（例如已禁用账号）保持不变
   * @param {Array<object>} activeTokens - 内存中的启用 token 列表（可能包含 sessionId）
   * @param {object|null} tokenToUpdate - 如果只需要单个更新，可传入该 token 以减少遍历
   */
  async mergeActiveTokens(activeTokens, tokenToUpdate = null) {
    const allTokens = [...await this.readAll()];

    const applyUpdate = (targetToken) => {
      if (!targetToken) return;
      const index = allTokens.findIndex(t => t.refresh_token === targetToken.refresh_token);
      if (index !== -1) {
        const { sessionId, ...plain } = targetToken;
        allTokens[index] = { ...allTokens[index], ...plain };
      }
    };

    if (tokenToUpdate) {
      applyUpdate(tokenToUpdate);
    } else if (Array.isArray(activeTokens) && activeTokens.length > 0) {
      for (const memToken of activeTokens) {
        applyUpdate(memToken);
      }
    }

    await this.writeAll(allTokens);
  }
}

export default TokenStore;
