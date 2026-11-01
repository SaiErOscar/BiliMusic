#!/usr/bin/env node
/**
 * 取出版本对应的发布说明（v1.4.14-pre2）。
 *
 * 约定：release-notes/<version>.md 手写发布说明，<version> 取 package.json 的 version。
 * 这是发布说明的唯一来源——不用 GitHub 自动生成的 commit 列表，那对用户没有意义。
 *
 * 兜底顺序：版本文件 → tag message → 明确提示缺失。
 * 缺失时不静默发一个空说明，而是让 CI 失败：宁可发不出去，也不要发一个没有内容的 release。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const root = process.cwd()
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = pkg.version
const outPath = path.join(root, 'release-notes', version + '.md')

function fromTag() {
  try {
    return execFileSync('git', ['tag', '-l', '--format=%(contents)', 'v' + version], {
      cwd: root,
      encoding: 'utf8',
    }).trim()
  } catch {
    return ''
  }
}

let body = ''
let source = ''

if (fs.existsSync(outPath)) {
  body = fs.readFileSync(outPath, 'utf8').trim()
  source = outPath
}

if (!body) {
  const tagBody = fromTag()
  // tag message 首行通常是「v1.4.14-pre1: 一句话摘要」，去掉重复的版本前缀
  if (tagBody) {
    body = tagBody.replace(new RegExp('^v?' + version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[:：]?\\s*'), '').trim()
    source = 'tag message'
  }
}

if (!body) {
  console.error('没有找到发布说明：缺少 release-notes/' + version + '.md，且 tag 上没有 message。')
  console.error('请在打 tag 前写好 release-notes/' + version + '.md。')
  process.exit(1)
}

const header = '# BiliMusic v' + version + '\n\n'
process.stdout.write(header + body + '\n')
console.error('release notes 来源：' + source)
