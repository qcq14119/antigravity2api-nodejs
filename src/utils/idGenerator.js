import { randomUUID, createHash, randomBytes } from 'crypto';

function generateRequestId() {
  return `agent-${randomUUID()}`;
}

function generateSessionId() {
  return String(-Math.floor(Math.random() * 9e18));
}

function generateProjectId() {
  const adjectives = ['useful', 'bright', 'swift', 'calm', 'bold'];
  const nouns = ['fuze', 'wave', 'spark', 'flow', 'core'];
  const randomAdj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const randomNoun = nouns[Math.floor(Math.random() * nouns.length)];
  const randomNum = Math.random().toString(36).substring(2, 7);
  return `${randomAdj}-${randomNoun}-${randomNum}`;
}

function generateToolCallId() {
  return `call_${randomUUID().replace(/-/g, '')}`;
}

/**
 * 生成随机盐值
 * @returns {string} 32字节的十六进制盐值
 */
function generateSalt() {
  return randomBytes(32).toString('hex');
}

/**
 * 根据 refresh_token 和盐值生成安全的 token ID
 * 使用 SHA256 哈希，取前16位作为标识符
 * @param {string} refreshToken - 原始 refresh_token
 * @param {string} salt - 盐值
 * @returns {string} 安全的 token ID
 */
function generateTokenId(refreshToken, salt) {
  if (!refreshToken || !salt) return null;
  return createHash('sha256').update(refreshToken + salt).digest('hex').substring(0, 16);
}

export {
    generateProjectId,
    generateSessionId,
    generateRequestId,
    generateToolCallId,
    generateTokenId,
    generateSalt
}