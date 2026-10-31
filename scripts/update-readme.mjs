#!/usr/bin/env node
/**
 * 拉取 GitHub 用户（默认 zhuweiyou）的公开仓库，自动生成个人主页 README.md。
 *
 * 用法：
 *   node scripts/update-readme.mjs            # 生成/更新 README.md + data/repos.json
 *   node scripts/update-readme.mjs --dry      # 只打印，不写文件
 *   GITHUB_TOKEN=ghp_xxx node scripts/update-readme.mjs   # 带 token，避免限流（无 token 时 60 次/小时）
 *
 * 可调环境变量：
 *   GH_USER        要拉取的用户名（默认 zhuweiyou）
 *   INCLUDE_FORKS  是否包含 fork 仓库，1/true 开启（默认排除）
 *   INCLUDE_ARCHIVED 是否包含已归档仓库，默认包含
 *   EXCLUDE        额外排除的仓库名，逗号分隔
 *
 * 零依赖，需要 Node.js 18+（使用内置 fetch）。
 */

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const USER = process.env.GH_USER || 'zhuweiyou';
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const INCLUDE_FORKS = /^(1|true|yes)$/i.test(process.env.INCLUDE_FORKS || '');
const INCLUDE_ARCHIVED = !/^(0|false|no)$/i.test(process.env.INCLUDE_ARCHIVED || '1');
const EXTRA_EXCLUDE = (process.env.EXCLUDE || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const DRY = process.argv.includes('--dry');
const README_PATH = path.join(ROOT, 'README.md');
const JSON_PATH = path.join(ROOT, 'data', 'repos.json');
const MARK_START = '<!-- REPOS:START -->';
const MARK_END = '<!-- REPOS:END -->';

const headers = {
  Accept: 'application/vnd.github+json',
  'User-Agent': `${USER}-profile-readme-generator`,
  'X-GitHub-Api-Version': '2022-11-28',
};
if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;

async function gh(url) {
  const res = await fetch(url, { headers });
  const remaining = res.headers.get('x-ratelimit-remaining');
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status} ${res.statusText} @ ${url}\n${body.slice(0, 300)}`);
  }
  if (remaining !== null && Number(remaining) <= 1) {
    console.warn(`⚠️  GitHub API 剩余额度仅 ${remaining}，建议设置 GITHUB_TOKEN。`);
  }
  return res.json();
}

async function fetchUser() {
  return gh(`https://api.github.com/users/${encodeURIComponent(USER)}`);
}

async function fetchAllRepos() {
  const all = [];
  for (let page = 1; ; page++) {
    const batch = await gh(
      `https://api.github.com/users/${encodeURIComponent(USER)}/repos` +
        `?per_page=100&page=${page}&type=owner&sort=updated`
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

const escapeCell = (s) =>
  String(s ?? '')
    .replace(/\r?\n+/g, ' ')
    .replace(/\|/g, '\\|')
    .replace(/\s+/g, ' ')
    .trim();

const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

// 统一按东八区（Asia/Shanghai, UTC+8）格式化为 YYYY-MM-DD
const fmtDate = (iso) => {
  if (!iso) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(new Date(iso))
    .replace(/\//g, '-');
};

// 东八区当前时间，形如 2026-10-31T20:12:00+08:00
const nowShanghaiISO = () => {
  const d = new Date();
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(d).map((x) => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour === '24' ? '00' : p.hour}:${p.minute}:${p.second}+08:00`;
};

function normalize(repos) {
  return repos
    .filter((r) => (INCLUDE_FORKS ? true : !r.fork))
    .filter((r) => (INCLUDE_ARCHIVED ? true : !r.archived))
    .filter((r) => r.name.toLowerCase() !== USER.toLowerCase()) // 排除主页仓库本身
    .filter((r) => !EXTRA_EXCLUDE.includes(r.name))
    .map((r) => ({
      name: r.name,
      url: r.html_url,
      description: (r.description || '').trim(),
      language: r.language || '',
      stars: r.stargazers_count ?? 0,
      forks: r.forks_count ?? 0,
      topics: r.topics || [],
      archived: !!r.archived,
      updatedAt: fmtDate(r.updated_at),
      pushedAt: fmtDate(r.pushed_at),
    }))
    .sort((a, b) => b.stars - a.stars || b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name));
}

const escapeHtml = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// 生成 HTML 表格：第 1 列（项目）与第 3 列（最后提交）不换行，第 2 列（简介）允许换行
// 用不换行连字符（U+2011）替代普通连字符，避免在 - 处断行（GitHub 会剥离 style，靠字符本身兜底）
const noBreak = (s) => String(s ?? '').replace(/-/g, '&#8209;');

function renderTable(repos, { showArchivedTag = true } = {}) {
  if (!repos.length) return '_暂无（无）_';
  const rows = repos.map((r) => {
    const tag = showArchivedTag && r.archived ? ' <code>已归档</code>' : '';
    const desc = escapeHtml(escapeCell(truncate(r.description || '—', 90)) || '—');
    return (
      `<tr>` +
      `<td style="white-space:nowrap"><a href="${escapeHtml(r.url)}">${noBreak(escapeHtml(r.name))}</a>${tag}</td>` +
      `<td style="white-space:normal">${desc}</td>` +
      `<td style="white-space:nowrap">${noBreak(r.pushedAt)}</td>` +
      `</tr>`
    );
  });
  return [
    '<table>',
    '<thead>',
    '<tr><th style="white-space:nowrap">项目</th><th style="white-space:normal">简介</th><th style="white-space:nowrap">最后提交</th></tr>',
    '</thead>',
    '<tbody>',
    ...rows,
    '</tbody>',
    '</table>',
  ].join('\n');
}

function renderLanguages(repos) {
  const counts = new Map();
  for (const r of repos) {
    if (!r.language) continue;
    counts.set(r.language, (counts.get(r.language) || 0) + 1);
  }
  const list = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!list.length) return '_暂无_';
  return list.map(([lang]) => `- **${lang}**`).join('\n');
}

function renderReadme(repos) {
  // 活跃仓库（非归档、非 fork）按最后一次提交时间倒序（新的在前）
  const active = repos
    .filter((r) => !r.archived)
    .sort((a, b) => b.pushedAt.localeCompare(a.pushedAt) || a.name.localeCompare(b.name));
  const archived = repos.filter((r) => r.archived);

  const updatedAt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .format(new Date())
    .replace(/\//g, '-');

  return `## 🧰 主要语言

${renderLanguages(repos)}

## 📦 全部公开仓库

${MARK_START}
### 🟢 活跃项目

${renderTable(active)}

### 🗄️ 归档项目

${renderTable(archived, { showArchivedTag: false })}
${MARK_END}

以上数据自动更新时间：${updatedAt}

`;
}

async function main() {
  console.log(`→ 拉取 ${USER} 的公开仓库…`);
  const [user, rawRepos] = await Promise.all([fetchUser(), fetchAllRepos()]);
  const repos = normalize(rawRepos);
  console.log(`  用户：${user.name || user.login}（公开仓库 ${user.public_repos}）`);
  console.log(`  参与展示：${repos.length} 个（排除 fork / 主页仓库后）`);

  const readme = renderReadme(repos);

  if (DRY) {
    console.log('\n----- README.md（预览）-----\n');
    console.log(readme);
    return;
  }

  await writeFile(README_PATH, readme, 'utf8');
  await mkdir(path.dirname(JSON_PATH), { recursive: true });
  await writeFile(
    JSON_PATH,
    JSON.stringify({ generatedAt: nowShanghaiISO(), user: { login: user.login, name: user.name, bio: user.bio, followers: user.followers, publicRepos: user.public_repos }, repos }, null, 2) + '\n',
    'utf8'
  );

  console.log(`✅ 已写入 ${path.relative(ROOT, README_PATH)}`);
  console.log(`✅ 已写入 ${path.relative(ROOT, JSON_PATH)}`);
}

main().catch((err) => {
  console.error('❌ 生成失败：', err.message);
  process.exit(1);
});
