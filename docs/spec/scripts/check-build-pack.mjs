#!/usr/bin/env node
// Trusted, read-only document validation. Never imports or executes pack contents.
import { constants, realpathSync } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const LIMITS = Object.freeze({ files: 2048, entries: 4096, depth: 16,
  fileBytes: 2 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, pathLength: 512,
  jsonDepth: 64, markdownConstructs: 4096, markdownCodeRuns: 5120, markdownScanSteps: 8 * 1024 * 1024,
  arrayRecords: 4096, idPrefixes: 128, errors: 200 });
const GROUPS = ['functional', 'nonfunctional', 'invariants'];
const EXECUTION_FIELDS = ['implementation', 'productTests', 'runtimeTests', 'integrationTests',
  'marketplaceIntegration', 'deployment', 'eventSubmission', 'publication', 'submission'];
const REQUIRED_EXECUTION = ['implementation', 'productTests', 'deployment'];
const EXTENSIONS = new Set(['.md', '.json', '.mjs', '.txt', '.yaml', '.yml', '.toml']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const normalize = value => value.replace(/\s+/g, ' ').trim();
const escapeRE = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const digest = value => createHash('sha256').update(value).digest('hex');
const ID = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/;
const portable = value => typeof value === 'string' && value.length > 0
  && value.length <= LIMITS.pathLength && !/[\\\x00-\x20\x7f-\x9f:%?#<>|"*]/.test(value)
  && !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..'
    && !part.endsWith('.') && !/^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³]|CONIN\$|CONOUT\$)(?:\.|$)/i.test(part));
const declaredStatuses = source => source.split(/\r?\n/).flatMap(line => {
  const match = line.match(/^\s*(?:[-*+]\s+)?(\*\*|__|`)?(?:(?:actual|current|test|execution|product)\s+)?status(?:\*\*|__|`)?\s*:\s*(.*)$/i);
  if (!match) return [];
  let tail = match[2], marker;
  if (match[1] && tail.startsWith(match[1])) tail = tail.slice(match[1].length).trimStart();
  marker = tail.match(/^(\*\*|__|`)/)?.[1];
  if (marker) tail = tail.slice(marker.length);
  let token = tail.match(/^[A-Za-z][A-Za-z0-9_-]*/)?.[0] ?? 'INVALID_STATUS';
  if ((marker === '__' || match[1] === '__') && token.endsWith('__')) token = token.slice(0, -2);
  return [token];
});

// JSON.parse alone silently accepts duplicate object keys. Reject them, including escaped keys.
function parseJSON(text) {
  const parsed = JSON.parse(text);
  let at = 0;
  const ws = () => { while (/\s/.test(text[at] ?? '') && at < text.length) at++; };
  function string() {
    const start = at++;
    while (at < text.length) {
      const ch = text[at++];
      if (ch === '\\') at++;
      else if (ch === '"') return JSON.parse(text.slice(start, at));
    }
    throw new Error('unterminated JSON string');
  }
  function value(depth) {
    if (depth > LIMITS.jsonDepth) throw new Error('JSON nesting exceeds limit');
    ws();
    if (text[at] === '{') {
      at++; ws(); const keys = new Set();
      if (text[at] === '}') { at++; return; }
      while (at < text.length) {
        ws(); const key = string();
        if (keys.has(key)) throw new Error(`duplicate JSON key: ${key}`);
        keys.add(key); ws(); at++; value(depth + 1); ws();
        if (text[at++] === '}') return;
      }
    } else if (text[at] === '[') {
      at++; ws(); if (text[at] === ']') { at++; return; }
      while (at < text.length) { value(depth + 1); ws(); if (text[at++] === ']') return; }
    } else if (text[at] === '"') string();
    else { while (at < text.length && !/[\s,}\]]/.test(text[at])) at++; }
  }
  value(0);
  return parsed;
}

async function rejectLinkedAncestors(root) {
  const parsed = path.parse(root);
  let current = parsed.root;
  for (const part of root.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error(`Symlink ancestor rejected: ${current}`);
    if (!stat.isDirectory()) throw new Error(`Root ancestor is not a directory: ${current}`);
  }
}

async function readBounded(file, expected) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > LIMITS.fileBytes
      || before.dev !== expected.dev || before.ino !== expected.ino)
      throw new Error('File changed or exceeded size limit before read');
    const buffer = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < buffer.length) {
      const result = await handle.read(buffer, count, buffer.length - count, count);
      if (!result.bytesRead) break;
      count += result.bytesRead;
    }
    const after = await handle.stat();
    if (count !== before.size || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
      throw new Error('File changed during read');
    return buffer.subarray(0, count);
  } finally { await handle.close(); }
}

function stripInlineCode(source, name) {
  // Code spans may cross soft line breaks, but cannot cross separate Markdown blocks.
  let constructs = 0;
  const chunks = [], paragraph = [];
  const flush = () => { if (paragraph.length) { chunks.push(maskBlock(paragraph.join('\n'))); paragraph.length = 0; } };
  function maskBlock(block) {
    constructs += (block.match(/`+/g) ?? []).length;
    if (constructs > LIMITS.markdownCodeRuns) throw new Error(`Markdown code-span count exceeds limit: ${name}`);
    return maskInlineCodeBlock(block);
  }
  for (const line of source.split('\n')) {
    if (!line.trim()) { flush(); chunks.push(line); }
    else if (/^ {0,3}(?:#{1,6}(?:\s|$)|(?:[-+*]|\d+[.)])\s+|>|\||(?:-{3,}|\*{3,}|_{3,})\s*$)/.test(line)) {
      flush(); chunks.push(maskBlock(line));
    } else paragraph.push(line);
  }
  flush(); return chunks.join('\n');
}

function maskInlineCodeBlock(source) {
  const runs = [...source.matchAll(/`+/g)];
  const next = [], afterEscapedFirst = [], last = new Map();
  for (let index = runs.length - 1; index >= 0; index--) {
    next[index] = last.get(runs[index][0].length);
    afterEscapedFirst[index] = last.get(runs[index][0].length - 1);
    last.set(runs[index][0].length, index);
  }
  let cursor = 0; const chunks = [];
  for (let index = 0; index < runs.length; index++) {
    let backslashes = 0;
    for (let before = runs[index].index - 1; before >= 0 && source[before] === '\\'; before--) backslashes++;
    const escaped = backslashes % 2;
    const closing = escaped ? afterEscapedFirst[index] : next[index];
    if (closing === undefined) continue;
    const end = runs[closing].index + runs[closing][0].length;
    const start = runs[index].index + escaped;
    chunks.push(source.slice(cursor, start), source.slice(start, end).replace(/[^\n]/g, ' '));
    cursor = end; index = closing;
  }
  chunks.push(source.slice(cursor)); return chunks.join('');
}

// A deliberately bounded Markdown subset: ATX headings, fences, inline/reference links.
function markdown(source, name, check) {
  const lines = source.split(/\r?\n/), prose = [], headings = [], headingStack = [], anchors = new Set(), slugs = new Map();
  let fence = null, fenced = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index], marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence.marker[0]
        && marker[1].length >= fence.marker.length && !marker[2].trim()) {
        if (fence.language === 'json') {
          try { parseJSON(fenced.join('\n')); } catch (error) { check(false, `Invalid fenced JSON in ${name}: ${error.message}`); }
        }
        fence = null; fenced = []; prose.push('');
      } else { fenced.push(line); prose.push(''); }
      continue;
    }
    if (marker) {
      check(!(marker[1][0] === '`' && marker[2].includes('`')), `Invalid fence in ${name}:${index + 1}`);
      fence = { marker: marker[1], language: marker[2].trim().split(/\s+/)[0].toLowerCase() }; prose.push(''); continue;
    }
    prose.push(line);
    const heading = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      if (headings.length >= LIMITS.markdownConstructs) throw new Error(`Markdown heading count exceeds limit: ${name}`);
      const title = heading[2], explicit = title.match(/\s+\{#([\w-]+)\}$/);
      const plain = title.replace(/\s+\{#[\w-]+\}$/, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/<[^>]*>/g, '').replace(/[`*_~]/g, '');
      const base = plain.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
      const occurrence = slugs.get(base) ?? 0; slugs.set(base, occurrence + 1);
      anchors.add(base + (occurrence ? `-${occurrence}` : ''));
      if (explicit) anchors.add(explicit[1]);
      const item = { level: heading[1].length, title, index, end: lines.length };
      while (headingStack.length && headingStack.at(-1).level >= item.level) headingStack.pop().end = index;
      headings.push(item); headingStack.push(item);
    }
    for (const match of line.matchAll(/<(?:a|span)\s+[^>]*?\bid=["']([^"']+)["'][^>]*>/gi)) anchors.add(match[1]);
  }
  check(fence === null, `Unbalanced fence in ${name}`);
  for (const heading of headings) heading.body = prose.slice(heading.index + 1, heading.end).join('\n').trim();
  const content = stripInlineCode(prose.join('\n'), name);
  return { headings, anchors, content };
}

function linkDestination(raw) {
  const value = raw.trim();
  const match = value.startsWith('<') ? value.match(/^<([^<>\n]*)>(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^\n]*\)))?$/)
    : value.match(/^((?:\\.|[^\s])+?)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^\n]*\)))?$/);
  if (!match) throw new Error(`Unsupported or malformed link destination: ${value.slice(0, 100)}`);
  return match[1].replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1');
}

function linksIn(document, name, check) {
  const references = new Map(), links = [], used = new Set();
  let scanned = 0, scanSteps = 0;
  const maxSteps = Math.min(LIMITS.markdownScanSteps, document.content.length * 8 + 1024);
  const step = () => { if (++scanSteps > maxSteps) throw new Error(`Markdown scan work exceeds limit: ${name}`); };
  const label = text => normalize(text).toLowerCase();
  const source = document.content.replace(/^ {0,3}\[([^\]\n]+)\]:\s*(.+)$/gm, (match, key, value) => {
    try {
      if (++scanned > LIMITS.markdownConstructs) throw new Error(`Markdown link count exceeds limit: ${name}`);
      const id = label(key); check(!references.has(id), `Duplicate link reference in ${name}: ${key}`);
      references.set(id, linkDestination(value));
    } catch (error) { check(false, `${name}: ${error.message}`); }
    return ' '.repeat(match.length);
  });
  for (let index = 0; index < source.length; index++) {
    step();
    if (source[index] === '\\') { index++; continue; }
    if (source[index] !== '[') continue;
    if (++scanned > LIMITS.markdownConstructs) throw new Error(`Markdown link count exceeds limit: ${name}`);
    let end = index + 1, nesting = 1;
    for (; end < source.length; end++) {
      step();
      if (source[end] === '\\') { end++; continue; }
      if (source[end] === '[') nesting++;
      if (source[end] === ']') { nesting--; if (nesting === 0) break; }
    }
    // Scan bracket nesting explicitly; malformed text alone is not a Markdown link.
    if (end >= source.length) break;
    const text = source.slice(index + 1, end), next = source[end + 1];
    if (next === '(') {
      let cursor = end + 2, depth = 1, angle = false, quote = null;
      for (; cursor < source.length; cursor++) {
        step();
        const ch = source[cursor];
        if (ch === '\\') { cursor++; continue; }
        if (quote) { if (ch === quote) quote = null; continue; }
        if (!angle && (ch === '"' || ch === "'") && /\s/.test(source[cursor - 1])) { quote = ch; continue; }
        if (ch === '<') angle = true;
        else if (ch === '>') angle = false;
        else if (!angle && ch === '(') depth++;
        else if (!angle && ch === ')' && --depth === 0) break;
      }
      if (depth) check(false, `Unclosed Markdown link in ${name}`);
      else {
        try { links.push(linkDestination(source.slice(end + 2, cursor))); }
        catch (error) { check(false, `${name}: ${error.message}`); }
        index = cursor;
      }
    } else if (next === '[') {
      const close = source.indexOf(']', end + 2);
      if (close < 0) { check(false, `Unclosed reference link in ${name}`); continue; }
      const key = label(source.slice(end + 2, close) || text);
      check(references.has(key), `Undefined link reference in ${name}: ${key}`);
      if (references.has(key)) { links.push(references.get(key)); used.add(key); }
      index = close;
    } else if (references.has(label(text))) {
      links.push(references.get(label(text))); used.add(label(text)); index = end;
    }
  }
  // An unused reference still represents a declared target and must resolve.
  for (const [key, target] of references) if (!used.has(key)) links.push(target);
  for (const match of source.matchAll(/<(?:a|img)\b[^>]*?\b(?:href|src)=["']([^"']+)["'][^>]*>/gi)) links.push(match[1]);
  return links;
}

export async function checkBuildPack({ root, config = 'pack-check.json' } = {}) {
  const errors = [], files = new Map(), texts = new Map(), json = new Map(), documents = new Map();
  let assertions = 0, entries = 0, totalBytes = 0, localLinks = 0;
  const counts = { functional: 0, nonfunctional: 0, invariants: 0, modules: 0, testCases: 0 };
  const check = (condition, message) => {
    assertions++;
    if (!condition) {
      if (errors.length >= LIMITS.errors) throw new Error('Error limit reached');
      errors.push(message);
    }
    return !!condition;
  };
  const exactKeys = (value, allowed, required, where) => {
    if (!check(object(value), `Expected object: ${where}`)) return false;
    for (const key of Object.keys(value)) check(allowed.includes(key), `Unknown field ${where}.${key}`);
    for (const key of required) check(Object.hasOwn(value, key), `Missing field ${where}.${key}`);
    return true;
  };
  const array = (value, where, nonempty = false) => {
    if (!check(Array.isArray(value), `Expected array: ${where}`)) return [];
    if (value.length > LIMITS.arrayRecords) throw new Error(`Array count exceeds limit: ${where}`);
    check(!nonempty || value.length > 0, `Empty array: ${where}`); return value;
  };
  const text = name => texts.get(name) ?? '';
  const exists = (name, where) => check(portable(name) && files.has(name), `Missing/unsafe file ${where}: ${String(name)}`);
  const unchanged = (value, where, nullable = false) => check(value === 'NOT_RUN' || (nullable && value === null), `Unsupported execution claim: ${where}`);
  try {
    if (typeof root !== 'string' || !root || root.split(/[\\/]/).includes('..')) throw new Error('A root without parent traversal is required');
    if (!portable(config) || !config.endsWith('.json')) throw new Error('Config must be a portable relative JSON path');
    const physicalRoot = path.resolve(root);
    await rejectLinkedAncestors(physicalRoot);
    async function walk(directory, prefix = '', depth = 0) {
      if (depth > LIMITS.depth) throw new Error('Directory depth exceeds limit');
      const names = [];
      for await (const entry of await opendir(directory)) {
        if (++entries > LIMITS.entries) throw new Error('Entry count exceeds limit');
        names.push(entry.name);
      }
      for (const item of names.sort()) {
        const name = prefix ? `${prefix}/${item}` : item;
        if (!portable(name)) throw new Error(`Nonportable pack path: ${name}`);
        const full = path.join(directory, item), stat = await lstat(full);
        if (stat.isSymbolicLink()) throw new Error(`Symlink rejected: ${name}`);
        if (stat.isDirectory()) await walk(full, name, depth + 1);
        else if (stat.isFile()) {
          if (files.size >= LIMITS.files) throw new Error('File count exceeds limit');
          if (stat.size > LIMITS.fileBytes || totalBytes + stat.size > LIMITS.totalBytes) throw new Error(`Byte size limit exceeded: ${name}`);
          if (!EXTENSIONS.has(path.posix.extname(name))) throw new Error(`Unsupported file extension: ${name}`);
          const bytes = await readBounded(full, stat);
          totalBytes += bytes.length; files.set(name, bytes);
          check(bytes.length > 0, `Empty file: ${name}`);
          check(!bytes.includes(0), `NUL/binary content: ${name}`);
          texts.set(name, new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        } else throw new Error(`Special file rejected: ${name}`);
      }
    }
    await walk(physicalRoot);
    for (const [name, value] of texts) {
      if (!name.endsWith('.mjs')) {
        check(!/\/(?:Users|Volumes|home)\/|[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/]|file:\/\/|(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%)[\\/]/i.test(value), `Author-machine path: ${name}`);
        check(!/\b(?:TODO|TBD|FIXME|INSERT_HERE|REPLACE_ME|YOUR_PROJECT|YOUR_NAME)\b|\{\{[^}\n]+\}\}|<<[^>\n]+>>/.test(value), `Unresolved placeholder: ${name}`);
      }
      if (name.endsWith('.json')) {
        try { json.set(name, parseJSON(value)); } catch (error) { check(false, `Invalid JSON ${name}: ${error.message}`); }
      }
      if (name.endsWith('.md')) documents.set(name, markdown(value, name, check));
    }
    const cfg = json.get(config);
    if (!exactKeys(cfg, ['schemaVersion', 'metadataFile', 'registryFile', 'coreFile', 'testPlanFile', 'requiredFiles', 'inventoryFile'],
      ['schemaVersion', 'metadataFile', 'registryFile', 'coreFile', 'testPlanFile', 'requiredFiles'], 'config')) throw new Error('Config missing or invalid');
    check(cfg.schemaVersion === 1, 'Unsupported config schemaVersion');
    const roleFiles = [cfg.metadataFile, cfg.registryFile, cfg.coreFile, cfg.testPlanFile];
    check(new Set(roleFiles).size === 4, 'Configured document roles must use distinct files');
    for (const key of ['metadataFile', 'registryFile', 'coreFile', 'testPlanFile']) exists(cfg[key], `config.${key}`);
    check(typeof cfg.metadataFile === 'string' && cfg.metadataFile.endsWith('.json'), 'metadataFile must be JSON');
    check(typeof cfg.registryFile === 'string' && cfg.registryFile.endsWith('.json'), 'registryFile must be JSON');
    check(typeof cfg.coreFile === 'string' && cfg.coreFile.endsWith('.md'), 'coreFile must be Markdown');
    check(typeof cfg.testPlanFile === 'string' && cfg.testPlanFile.endsWith('.md'), 'testPlanFile must be Markdown');
    const required = new Set();
    for (const raw of array(cfg.requiredFiles, 'config.requiredFiles', true)) {
      const item = typeof raw === 'string' ? { path: raw } : raw;
      if (!exactKeys(item, ['path', 'minBytes'], ['path'], 'requiredFiles item')) continue;
      check(!required.has(item.path), `Duplicate required path: ${item.path}`); required.add(item.path);
      const minimum = Object.hasOwn(item, 'minBytes') ? item.minBytes : 1;
      check(Number.isSafeInteger(minimum) && minimum > 0 && minimum <= LIMITS.fileBytes, `Invalid minBytes: ${item.path}`);
      if (exists(item.path, 'requiredFiles')) check(files.get(item.path).length >= minimum, `Required file too small: ${item.path}`);
    }
    if (Object.hasOwn(cfg, 'inventoryFile')) exists(cfg.inventoryFile, 'config.inventoryFile');
    const meta = json.get(cfg.metadataFile), registry = json.get(cfg.registryFile);
    if (!object(meta) || !object(registry)) throw new Error('Metadata or registry is not a JSON object');
    check(meta.schemaVersion === 1, 'Unsupported metadata schemaVersion');
    check(meta.status === 'SPECIFICATION_ONLY', 'Metadata must be SPECIFICATION_ONLY');
    for (const field of REQUIRED_EXECUTION) unchanged(meta[field], `metadata.${field}`);
    for (const field of EXECUTION_FIELDS.filter(field => !REQUIRED_EXECUTION.includes(field)))
      if (Object.hasOwn(meta, field)) unchanged(meta[field], `metadata.${field}`, true);
    if (Object.hasOwn(meta, 'marketValidation')) check(meta.marketValidation === 'UNPROVEN' || meta.marketValidation === null, 'Metadata marketValidation must be UNPROVEN or null');
    function gates(value, where) {
      if (!check(object(value), `Expected gate object: ${where}`)) return;
      for (const [key, gate] of Object.entries(value)) unchanged(object(gate) ? gate.status : gate, `${where}.${key}`);
    }
    if (Object.hasOwn(meta, 'gates')) gates(meta.gates, 'metadata.gates');
    if (exactKeys(registry, ['schemaVersion', 'status', 'definitions', 'tests', 'modules'],
      ['schemaVersion', 'status', 'definitions', 'tests', 'modules'], 'registry')) {
      check(registry.schemaVersion === 1, 'Unsupported registry schemaVersion');
      check(registry.status === 'SPECIFICATION_ONLY', 'Registry must be SPECIFICATION_ONLY');
    }
    const known = new Set(), definitionSets = {}, testIds = new Set(), modules = new Map();
    const register = (id, where) => {
      check(typeof id === 'string' && id.length <= 80 && ID.test(id), `Invalid ID: ${where}`);
      check(!known.has(id), `Duplicate ID: ${String(id)}`); known.add(id);
    };
    const headingFor = (name, id, title) => {
      const candidates = (documents.get(name)?.headings ?? []).filter(heading => heading.level === 3
        && new RegExp(`^${escapeRE(String(id))}(?:\\s|$)`).test(heading.title));
      check(candidates.length === 1, `Missing/duplicate heading ${name}: ${id}`);
      if (candidates.length === 1) check(candidates[0].title === `${id} — ${title}`, `Heading title differs ${name}: ${id}`);
      return candidates[0];
    };
    exactKeys(registry.definitions, GROUPS, GROUPS, 'registry.definitions');
    for (const group of GROUPS) {
      const definitions = array(registry.definitions?.[group], `definitions.${group}`, true);
      counts[group] = definitions.length; definitionSets[group] = new Set();
      for (const definition of definitions) {
        if (!exactKeys(definition, ['id', 'title', 'definition'], ['id', 'title', 'definition'], `definition.${group}`)) continue;
        register(definition.id, group); definitionSets[group].add(definition.id);
        check(typeof definition.title === 'string' && !!definition.title.trim(), `Missing title: ${definition.id}`);
        if (!check(typeof definition.definition === 'string' && !!definition.definition.trim(), `Missing definition: ${definition.id}`)) continue;
        const heading = headingFor(cfg.coreFile, definition.id, definition.title);
        if (heading) check(normalize(heading.body.split(/\n\s*\n/)[0]) === normalize(definition.definition), `Core definition differs: ${definition.id}`);
      }
    }
    const tests = array(registry.tests, 'registry.tests', true); counts.testCases = tests.length;
    for (const test of tests) {
      if (!exactKeys(test, ['id', 'title', 'status'], ['id', 'title', 'status'], 'registry test')) continue;
      register(test.id, 'tests'); testIds.add(test.id); unchanged(test.status, `test.${test.id}`);
      check(typeof test.title === 'string' && !!test.title.trim(), `Missing test title: ${test.id}`);
      const heading = headingFor(cfg.testPlanFile, test.id, test.title);
      if (heading) {
        const statuses = declaredStatuses(heading.body);
        check(statuses.length > 0 && statuses.every(status => status === 'NOT_RUN'), `Test section status must be NOT_RUN: ${test.id}`);
      }
    }
    const moduleList = array(registry.modules, 'registry.modules', true); counts.modules = moduleList.length;
    const promptFiles = new Set();
    for (const module of moduleList) {
      if (!exactKeys(module, ['id', 'name', 'title', 'file', 'requirements', 'nonfunctional', 'invariants', 'tests', 'dependsOn', 'status'],
        ['id', 'file', 'requirements', 'nonfunctional', 'invariants', 'tests', 'dependsOn', 'status'], 'registry module')) continue;
      register(module.id, 'modules'); modules.set(module.id, module); unchanged(module.status, `module.${module.id}`);
      exists(module.file, `module.${module.id}`);
      check(typeof module.file === 'string' && module.file.endsWith('.md'), `Module file must be Markdown: ${module.id}`);
      check(!promptFiles.has(module.file) && !roleFiles.includes(module.file), `Module prompt file reused: ${module.file}`); promptFiles.add(module.file);
    }
    const coverage = new Set(), owners = new Map();
    for (const [id, module] of modules) {
      const prose = documents.get(module.file)?.content ?? '';
      const contains = token => new RegExp(`(?<![A-Z0-9_-])${escapeRE(String(token))}(?![A-Z0-9_-])`).test(prose);
      check(contains(id), `Prompt missing module ID: ${id}`);
      check(contains('SPECIFICATION_ONLY') && contains('NOT_RUN'), `Prompt missing specification status: ${id}`);
      const mappings = [['requirements', definitionSets.functional], ['nonfunctional', definitionSets.nonfunctional], ['invariants', definitionSets.invariants], ['tests', testIds], ['dependsOn', new Set(modules.keys())]];
      for (const [field, allowed] of mappings) {
        const values = array(module[field], `${id}.${field}`, field === 'tests');
        check(new Set(values).size === values.length, `Duplicate mapping: ${id}.${field}`);
        for (const value of values) {
          check(allowed.has(value), `Dangling/wrong-category ID: ${id}.${field} -> ${String(value)}`);
          check(contains(value), `Prompt missing mapped ID: ${id} -> ${String(value)}`);
          if (field === 'tests') owners.set(value, (owners.get(value) ?? 0) + 1);
          else if (field !== 'dependsOn') coverage.add(value);
        }
      }
    }
    for (const group of GROUPS) for (const id of definitionSets[group]) check(coverage.has(id), `Uncovered definition: ${id}`);
    for (const id of testIds) check(owners.get(id) === 1, `Test must have exactly one owning module: ${id}`);
    const visiting = new Set(), visited = new Set();
    function visit(id) {
      if (visiting.has(id)) { check(false, `Cyclic module dependency: ${id}`); return; }
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dep of Array.isArray(modules.get(id)?.dependsOn) ? modules.get(id).dependsOn : []) if (modules.has(dep)) visit(dep);
      visiting.delete(id); visited.add(id);
    }
    for (const id of modules.keys()) visit(id);
    if (Object.hasOwn(meta, 'counts') && exactKeys(meta.counts, Object.keys(counts), [], 'metadata.counts'))
      for (const [key, value] of Object.entries(meta.counts)) check(value === counts[key], `Metadata count differs: ${key}`);
    // Execution templates are identified explicitly; arbitrary research/history statuses are permitted.
    for (const [name, value] of json) {
      if (!object(value) || value.recordKind !== 'TEMPLATE_NOT_EXECUTION_EVIDENCE') continue;
      unchanged(value.status, `${name}.status`);
      if (Object.hasOwn(value, 'gates')) gates(value.gates, `${name}.gates`);
      if (Object.hasOwn(value, 'externalActions')) check(Array.isArray(value.externalActions) && value.externalActions.length === 0, `Template external actions claimed: ${name}`);
      function templateClaims(node, where) {
        if (Array.isArray(node)) { node.forEach((item, index) => templateClaims(item, `${where}[${index}]`)); return; }
        if (!object(node)) return;
        for (const [key, item] of Object.entries(node)) {
          if (key === 'status') unchanged(item, `${where}.${key}`, true);
          if (['redEvidence', 'greenEvidence', 'headSha', 'handoff'].includes(key)) check(item === null, `Template execution evidence claimed: ${where}.${key}`);
          if (['commands', 'evidence', 'externalActions'].includes(key)) check(Array.isArray(item) && item.length === 0, `Template executed commands/evidence/actions: ${where}.${key}`);
          if (EXECUTION_FIELDS.includes(key)) unchanged(item, `${where}.${key}`, true);
          templateClaims(item, `${where}.${key}`);
        }
      }
      templateClaims(value, name);
    }
    const patterns = new Set(['FR-\\d+', 'NFR-\\d+', 'INV-\\d+', 'T-\\d+', 'M\\d+']);
    for (const id of known) if (typeof id === 'string') {
      const match = id.match(/^(.*-)[A-Z0-9]+$/);
      if (match) patterns.add(`${escapeRE(match[1])}[A-Z0-9]+(?:-[A-Z0-9]+)*`);
      if (patterns.size > LIMITS.idPrefixes) throw new Error('ID prefix count exceeds limit');
    }
    const ids = new RegExp(`(?<![A-Z0-9-])(?:${[...patterns].join('|')})(?![A-Z0-9-])`, 'g');
    for (const [name, document] of documents) {
      for (const match of document.content.matchAll(ids)) check(known.has(match[0]), `Unknown ID in ${name}: ${match[0]}`);
      for (const raw of linksIn(document, name, check)) {
        if (/^(?:https?:|mailto:)/i.test(raw)) continue;
        let target;
        try { target = decodeURIComponent(raw); } catch { check(false, `Malformed link encoding in ${name}: ${raw}`); continue; }
        if (!check(!/^[A-Za-z][A-Za-z0-9+.-]*:|^[\\/]|[\\\x00-\x1f]/.test(target), `Unsafe link in ${name}: ${raw}`)) continue;
        const hashAt = target.indexOf('#'), fragment = hashAt < 0 ? '' : target.slice(hashAt + 1);
        const file = (hashAt < 0 ? target : target.slice(0, hashAt)).split('?')[0];
        const resolved = file ? path.posix.normalize(path.posix.join(path.posix.dirname(name), file)) : name;
        if (!check(portable(resolved) && files.has(resolved), `Broken/escaping link in ${name}: ${raw}`)) continue;
        localLinks++;
        if (fragment && documents.has(resolved)) check(documents.get(resolved).anchors.has(fragment), `Broken heading anchor in ${name}: ${raw}`);
      }
    }
    const inventoryName = cfg.inventoryFile ?? (files.has('PACK-INVENTORY.json') ? 'PACK-INVENTORY.json' : null);
    if (inventoryName) {
      check(typeof inventoryName === 'string' && inventoryName.endsWith('.json'), 'inventoryFile must be JSON');
      const inventory = json.get(inventoryName);
      if (exactKeys(inventory, ['schemaVersion', 'algorithm', 'note', 'files'], ['schemaVersion', 'files'], 'inventory')) {
        check(inventory.schemaVersion === 1, 'Unsupported inventory schemaVersion');
        if (Object.hasOwn(inventory, 'algorithm')) check(inventory.algorithm === 'sha256', 'Unsupported inventory algorithm');
        const indexed = new Set();
        for (const entry of array(inventory.files, 'inventory.files', true)) {
          if (!exactKeys(entry, ['path', 'bytes', 'sha256'], ['path', 'bytes'], 'inventory entry')) continue;
          check(!indexed.has(entry.path), `Duplicate inventory path: ${entry.path}`); indexed.add(entry.path);
          if (!exists(entry.path, 'inventory')) continue;
          check(entry.path !== inventoryName, 'Inventory cannot include itself');
          check(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && entry.bytes === files.get(entry.path).length, `Inventory size differs: ${entry.path}`);
          if (Object.hasOwn(entry, 'sha256')) {
            check(inventory.algorithm === 'sha256', 'Hashed inventory requires algorithm sha256');
            check(typeof entry.sha256 === 'string' && /^[0-9a-f]{64}$/.test(entry.sha256) && entry.sha256 === digest(files.get(entry.path)), `Inventory checksum differs: ${entry.path}`);
          }
        }
        const actual = [...files.keys()].filter(name => name !== inventoryName);
        check(indexed.size === actual.length && actual.every(name => indexed.has(name)), 'Inventory membership differs');
      }
    }
  } catch (error) {
    if (errors.length < LIMITS.errors + 1) errors.push(error.message);
  }
  return { schemaVersion: 1, scope: 'DOCUMENT_ONLY', result: errors.length ? 'FAIL' : 'PASS',
    semanticReview: 'NOT_PERFORMED', productTests: 'NOT_RUN', researchVerification: 'NOT_PERFORMED',
    files: files.size, markdown: documents.size, totalBytes, localLinks, assertions, counts, limits: LIMITS, errors };
}

async function main(args) {
  const options = {}, seen = new Set();
  try {
    for (let index = 0; index < args.length; index += 2) {
      const flag = args[index], value = args[index + 1];
      if (!['--root', '--config'].includes(flag) || seen.has(flag) || !value || value.startsWith('--'))
        throw new Error('Usage: node check-build-pack.mjs --root PACK_DIR [--config relative/config.json]');
      seen.add(flag); options[flag.slice(2)] = value;
    }
    if (!options.root) throw new Error('--root is required');
    const report = await checkBuildPack(options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.result === 'PASS' ? 0 : 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, scope: 'DOCUMENT_ONLY', result: 'FAIL',
      semanticReview: 'NOT_PERFORMED', productTests: 'NOT_RUN', researchVerification: 'NOT_PERFORMED', errors: [error.message] }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
const realOrSelf = (file) => { try { return realpathSync(file); } catch { return path.resolve(file); } };
// Compare real paths: Node resolves import.meta.url through symlinks (macOS /tmp, symlinked skill dirs) but argv[1] keeps the
// invoked spelling, so a plain string compare silently skipped main() and exited 0 with no report.
if (process.argv[1] && realOrSelf(process.argv[1]) === realOrSelf(fileURLToPath(import.meta.url))) await main(process.argv.slice(2));
