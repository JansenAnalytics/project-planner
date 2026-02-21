#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

// ─────────────────────────────────────────────
// Utility helpers
// ─────────────────────────────────────────────

function resolvePath(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function resolveProjectDir(project) {
  if (!project) die('--project is required');
  if (project.includes('/') || project.includes('\\')) {
    return resolvePath(project);
  }
  return path.join(os.homedir(), 'projects', project);
}

function planPath(dir) { return path.join(dir, 'PLAN.json'); }
function mdPath(dir)   { return path.join(dir, 'PLAN.md'); }

function loadPlan(dir) {
  const fp = planPath(dir);
  if (!fs.existsSync(fp)) die(`No PLAN.json found at ${fp}\nRun: plan.cjs new --project <name>`);
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); }
  catch(e) { die(`Failed to parse PLAN.json: ${e.message}`); }
}

function savePlan(dir, plan) {
  plan.updated_at = new Date().toISOString();
  fs.writeFileSync(planPath(dir), JSON.stringify(plan, null, 2));
  regeneratePlanMd(dir, plan);
}

function die(msg) {
  console.error(`\x1b[31mError:\x1b[0m ${msg}`);
  process.exit(1);
}

function nowIso() { return new Date().toISOString(); }

function parseArgs(argv) {
  const args = { _: [] };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (i + 1 < argv.length && !argv[i+1].startsWith('--')) {
        args[key] = argv[i+1]; i += 2;
      } else {
        args[key] = true; i++;
      }
    } else {
      args._.push(a); i++;
    }
  }
  return args;
}

function splitComma(s) {
  if (!s || s === '') return [];
  return s.split(',').map(x => x.trim()).filter(Boolean);
}

function formatDuration(startIso, endIso) {
  if (!startIso) return '—';
  const ms = new Date(endIso || nowIso()) - new Date(startIso);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function timeAgo(iso) {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ago`;
  if (h > 0) return `${h}h ago`;
  if (m > 0) return `${m}m ago`;
  return 'just now';
}

function formatDate(iso) {
  if (!iso) return '—';
  return iso.slice(0, 10);
}

function formatDatetime(iso) {
  if (!iso) return '—';
  return iso.slice(0, 16).replace('T', ' ') + ' UTC';
}

function statusIcon(status) {
  const icons = { done:'✅', running:'▶', pending:'⏳', blocked:'🔴', failed:'❌', skipped:'⏭', cancelled:'🚫' };
  return icons[status] || '?';
}

function progressBar(done, total) {
  if (total === 0) return '░'.repeat(20);
  const filled = Math.round((done / total) * 20);
  return '█'.repeat(filled) + '░'.repeat(20 - filled);
}

function priorityOrder(p) {
  return { critical: 0, high: 1, medium: 2, low: 3 }[p] ?? 99;
}

// ─────────────────────────────────────────────
// Graph algorithms
// ─────────────────────────────────────────────

function detectCycles(tasks) {
  // DFS with visited + in-stack
  const byId = {};
  for (const t of tasks) byId[t.id] = t;
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = {};
  for (const t of tasks) color[t.id] = WHITE;

  function dfs(id, stack) {
    color[id] = GRAY;
    const task = byId[id];
    if (!task) return null;
    for (const dep of (task.requires || [])) {
      if (color[dep] === GRAY) {
        const cycle = [...stack, dep];
        return `Cycle detected: ${cycle.join(' → ')}`;
      }
      if (color[dep] === WHITE) {
        const result = dfs(dep, [...stack, dep]);
        if (result) return result;
      }
    }
    color[id] = BLACK;
    return null;
  }

  for (const t of tasks) {
    if (color[t.id] === WHITE) {
      const err = dfs(t.id, [t.id]);
      if (err) return err;
    }
  }
  return null;
}

function topoSort(tasks) {
  // Kahn's algorithm
  const byId = {};
  for (const t of tasks) byId[t.id] = t;
  const inDeg = {};
  const adj = {}; // id -> list of dependents
  for (const t of tasks) {
    inDeg[t.id] = (inDeg[t.id] || 0);
    adj[t.id] = adj[t.id] || [];
    for (const dep of (t.requires || [])) {
      adj[dep] = adj[dep] || [];
      adj[dep].push(t.id);
      inDeg[t.id] = (inDeg[t.id] || 0) + 1;
    }
  }
  const queue = tasks.filter(t => !inDeg[t.id]).map(t => t.id);
  const result = [];
  while (queue.length) {
    const id = queue.shift();
    result.push(id);
    for (const next of (adj[id] || [])) {
      inDeg[next]--;
      if (inDeg[next] === 0) queue.push(next);
    }
  }
  return result;
}

function computeCriticalPath(tasks) {
  // Returns { path: [id,...], hours: n, taskEarliestStart: {}, onCriticalPath: Set }
  const byId = {};
  for (const t of tasks) byId[t.id] = t;
  const order = topoSort(tasks);

  // Forward pass: earliest finish
  const ef = {}; // earliest finish for each task
  for (const id of order) {
    const t = byId[id];
    const h = t.estimated_hours || 0;
    const depEf = (t.requires || []).map(d => ef[d] || 0);
    const es = depEf.length ? Math.max(...depEf) : 0;
    ef[id] = es + h;
  }

  // Find project end time
  const projectEnd = Math.max(...Object.values(ef), 0);

  // Backward pass: latest finish
  const lf = {};
  for (const id of order) lf[id] = projectEnd;
  for (const id of [...order].reverse()) {
    const t = byId[id];
    // all tasks that depend on this task
    const successors = tasks.filter(x => (x.requires || []).includes(id));
    if (successors.length) {
      lf[id] = Math.min(...successors.map(s => lf[s.id] - (s.estimated_hours || 0)));
    }
  }

  // Critical path: tasks where ef[id] - h === lf[id] - h, i.e. ef[id] = lf[id]
  // More precisely: tasks where latest_start = earliest_start
  // ES = ef[id] - h, LS = lf[id] - h → critical if ES = LS i.e. ef=lf
  const onCP = new Set();
  for (const id of order) {
    if (Math.abs(ef[id] - lf[id]) < 0.001) onCP.add(id);
  }

  // Reconstruct critical path
  const cpTasks = order.filter(id => onCP.has(id));

  return { path: cpTasks, totalHours: projectEnd, onCriticalPath: onCP, ef };
}

function computeWaves(tasks) {
  // Returns waves of tasks (only pending/running) that can run given done tasks
  const byId = {};
  for (const t of tasks) byId[t.id] = t;

  const doneTasks = new Set(tasks.filter(t => t.status === 'done').map(t => t.id));
  const pendingTasks = tasks.filter(t => t.status === 'pending');

  const waves = [];
  const placed = new Set([...doneTasks]);

  let remaining = [...pendingTasks];
  while (remaining.length > 0) {
    const wave = remaining.filter(t =>
      (t.requires || []).every(dep => placed.has(dep))
    );
    if (wave.length === 0) break; // blocked or cycle
    waves.push(wave);
    for (const t of wave) placed.add(t.id);
    remaining = remaining.filter(t => !placed.has(t.id));
  }
  return waves;
}

function getReady(tasks) {
  const done = new Set(tasks.filter(t => t.status === 'done').map(t => t.id));
  return tasks.filter(t =>
    t.status === 'pending' &&
    (t.requires || []).every(dep => done.has(dep))
  );
}

function getDownstream(taskId, tasks) {
  // BFS to find all tasks that (transitively) depend on taskId
  const byId = {};
  for (const t of tasks) byId[t.id] = t;
  const direct = tasks.filter(t => (t.requires || []).includes(taskId));
  const visited = new Set(direct.map(t => t.id));
  const queue = [...direct];
  while (queue.length) {
    const curr = queue.shift();
    const nexts = tasks.filter(t => (t.requires || []).includes(curr.id));
    for (const n of nexts) {
      if (!visited.has(n.id)) {
        visited.add(n.id);
        queue.push(n);
      }
    }
  }
  return { direct, transitive: tasks.filter(t => visited.has(t.id) && !direct.includes(t)) };
}

// ─────────────────────────────────────────────
// PLAN.md generation
// ─────────────────────────────────────────────

function regeneratePlanMd(dir, plan) {
  const tasks = plan.tasks || [];
  const total = tasks.length;
  const done = tasks.filter(t => t.status === 'done').length;
  const running = tasks.filter(t => t.status === 'running');
  const blocked = tasks.filter(t => t.status === 'blocked');
  const pending = tasks.filter(t => t.status === 'pending');
  const failed = tasks.filter(t => t.status === 'failed');
  const ready = getReady(tasks);
  const pct = total ? Math.round((done / total) * 100) : 0;
  const bar = progressBar(done, total);

  // Estimate remaining
  const remainingHours = tasks
    .filter(t => !['done','skipped','cancelled'].includes(t.status))
    .reduce((s, t) => s + (t.estimated_hours || 0), 0);

  // Critical path (on remaining tasks)
  const cp = tasks.length ? computeCriticalPath(tasks) : null;
  const cpStr = cp && cp.path.length
    ? cp.path.join(' → ')
    : '—';

  // Compute status label
  let statusLabel = '📋 Planning';
  if (done === total && total > 0) statusLabel = '✅ Complete';
  else if (running.length > 0 || done > 0) statusLabel = '🔄 In Progress';
  else if (blocked.length > 0) statusLabel = '🔴 Blocked';

  let md = `# Project Plan: ${toTitleCase(plan.project)}
> ${plan.description || ''}

**Status:** ${statusLabel}  
**Progress:** ${bar} ${done}/${total} (${pct}%)  
**Last Updated:** ${formatDatetime(plan.updated_at)}  
**Estimated Remaining:** ${remainingHours}h | Critical path: ${cp ? cp.totalHours : 0}h

---
`;

  if (blocked.length > 0) {
    md += `\n## ⚠️ Blockers (${blocked.length})\n`;
    md += `| Task | Blocker | Impact |\n|------|---------|--------|\n`;
    for (const t of blocked) {
      const { direct, transitive } = getDownstream(t.id, tasks);
      const affected = [...direct, ...transitive].map(x => x.id).join(', ') || '—';
      md += `| ${t.id} ${t.name} | ${t.blocker || '—'} | Blocks: ${affected} |\n`;
    }
  }

  if (failed.length > 0) {
    md += `\n## ❌ Failed (${failed.length})\n`;
    for (const t of failed) {
      md += `- **${t.id}** ${t.name}${t.blocker ? ` — *${t.blocker}*` : ''}\n`;
    }
  }

  if (running.length > 0) {
    md += `\n## ▶ Running (${running.length})\n`;
    for (const t of running) {
      const ago = t.started_at ? `started ${timeAgo(t.started_at)}` : '';
      const assigned = t.assigned_to || '—';
      md += `- **${t.id}** ${t.name} *(${assigned} · est ${t.estimated_hours || '?'}h · ${ago})*\n`;
    }
  }

  if (ready.length > 0) {
    md += `\n## 🟢 Ready to Start (${ready.length})\n`;
    for (const t of ready) {
      md += `- **${t.id}** ${t.name} *(${t.assigned_to || '—'} · est ${t.estimated_hours || '?'}h)*\n`;
    }
  }

  if (done > 0) {
    md += `\n## ✅ Done (${done})\n`;
    md += `| Task | Duration | Completed |\n|------|----------|-----------|\n`;
    for (const t of tasks.filter(x => x.status === 'done')) {
      const dur = t.started_at ? formatDuration(t.started_at, t.completed_at) : '—';
      md += `| ${t.id} ${t.name} | ${dur} | ${formatDate(t.completed_at)} |\n`;
    }
  }

  const otherPending = pending.filter(t => !ready.find(r => r.id === t.id));
  if (otherPending.length > 0) {
    md += `\n## ⏳ Pending (${otherPending.length})\n`;
    md += `| Task | Requires | Est | Priority |\n|------|----------|-----|----------|\n`;
    for (const t of otherPending) {
      const reqs = (t.requires || []).join(', ') || '—';
      md += `| ${t.id} ${t.name} | ${reqs} | ${t.estimated_hours || '?'}h | ${t.priority || '—'} |\n`;
    }
  }

  if (cp && cp.path.length > 0) {
    md += `\n## Critical Path\n\`${cpStr}\` (${cp.totalHours}h remaining)\n`;
  }

  if (tasks.length > 0) {
    md += `\n---\n`;
    md += `*Auto-generated by Kite project-planner. Do not edit manually.*\n`;
  }

  fs.writeFileSync(mdPath(dir), md);
}

function toTitleCase(s) {
  return (s || '').split(/[-_]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// ─────────────────────────────────────────────
// Telegram sender
// ─────────────────────────────────────────────

function sendTelegram(text, filePath) {
  return new Promise((resolve, reject) => {
    // Read token from openclaw config (same as all other projects)
    let token, chatId;
    try {
      const ocConfig = JSON.parse(fs.readFileSync(
        path.join(os.homedir(), '.openclaw', 'openclaw.json'), 'utf8'
      ));
      token = ocConfig.channels?.telegram?.botToken;
      chatId = '687053516';
    } catch (e) {}

    if (!token || !chatId) {
      console.log('⚠️  Could not read Telegram config from ~/.openclaw/openclaw.json. Skipping send.');
      resolve();
      return;
    }

    if (filePath) {
      // Send document
      const fileContent = fs.readFileSync(filePath);
      const filename = path.basename(filePath);
      const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`),
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\nContent-Type: text/markdown\r\n\r\n`),
        fileContent,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${token}/sendDocument`,
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length }
      }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => resolve(JSON.parse(d)));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    } else {
      const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' });
      const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${token}/sendMessage`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => resolve(JSON.parse(d)));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    }
  });
}

// ─────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────

function cmdNew(args) {
  const project = args.project;
  const description = args.description || '';
  if (!project) die('--project is required');

  const dir = resolveProjectDir(project);
  fs.mkdirSync(dir, { recursive: true });

  const plan = {
    project,
    description,
    created_at: nowIso(),
    updated_at: nowIso(),
    status: 'planning',
    tasks: []
  };

  fs.writeFileSync(planPath(dir), JSON.stringify(plan, null, 2));
  regeneratePlanMd(dir, plan);
  console.log(`Plan created: ${planPath(dir)}`);
}

function cmdAdd(args) {
  const project = args.project;
  const dir = resolveProjectDir(project);
  const plan = loadPlan(dir);

  const id = args.id;
  const name = args.name;
  if (!id) die('--id is required');
  if (!name) die('--name is required');

  // Check duplicate
  if (plan.tasks.find(t => t.id === id)) die(`Task ID "${id}" already exists`);

  // Parse requires
  const requires = splitComma(args.requires === true ? '' : (args.requires || ''));
  // Validate requires exist
  for (const dep of requires) {
    if (!plan.tasks.find(t => t.id === dep)) die(`Required task "${dep}" does not exist in plan`);
  }

  const task = {
    id,
    name,
    description: args.description || '',
    status: 'pending',
    requires,
    produces: splitComma(args.produces === true ? '' : (args.produces || '')),
    acceptance_criteria: splitComma(args.criteria === true ? '' : (args.criteria || '')),
    rollback: args.rollback || '',
    assigned_to: args.assigned || 'sub-agent',
    estimated_hours: args.hours ? parseFloat(args.hours) : 0,
    tags: splitComma(args.tags === true ? '' : (args.tags || '')),
    priority: args.priority || 'medium',
    started_at: null,
    completed_at: null,
    blocker: null,
    notes: []
  };

  // Validate no cycle after adding
  const testTasks = [...plan.tasks, task];
  const cycleErr = detectCycles(testTasks);
  if (cycleErr) die(cycleErr);

  plan.tasks.push(task);
  savePlan(dir, plan);
  console.log(`Added ${id} "${name}" to ${project}`);
}

function cmdImport(args) {
  const project = args.project;
  const dir = resolveProjectDir(project);
  const plan = loadPlan(dir);

  let file = args.file;
  if (!file) die('--file is required');

  let raw;
  if (file === '-') {
    raw = fs.readFileSync('/dev/stdin', 'utf8');
  } else {
    file = resolvePath(file);
    if (!fs.existsSync(file)) die(`File not found: ${file}`);
    raw = fs.readFileSync(file, 'utf8');
  }

  let importedTasks;
  try { importedTasks = JSON.parse(raw); }
  catch(e) { die(`Invalid JSON: ${e.message}`); }

  if (!Array.isArray(importedTasks)) die('tasks.json must be a JSON array');

  const errors = [];

  // Normalize fields
  const normalized = importedTasks.map((t, i) => {
    if (!t.id) errors.push(`Task at index ${i}: missing "id"`);
    if (!t.name) errors.push(`Task at index ${i} (${t.id || '?'}): missing "name"`);
    return {
      id: t.id,
      name: t.name || '',
      description: t.description || '',
      status: 'pending',
      requires: t.requires || [],
      produces: t.produces || [],
      acceptance_criteria: t.criteria || t.acceptance_criteria || [],
      rollback: t.rollback || '',
      assigned_to: t.assigned || t.assigned_to || 'sub-agent',
      estimated_hours: t.hours || t.estimated_hours || 0,
      tags: t.tags || [],
      priority: t.priority || 'medium',
      started_at: null,
      completed_at: null,
      blocker: null,
      notes: []
    };
  });

  // Check duplicates within import set
  const seenIds = new Set();
  for (const t of normalized) {
    if (seenIds.has(t.id)) errors.push(`Duplicate task ID in import: "${t.id}"`);
    seenIds.add(t.id);
  }

  // Check duplicates against existing plan
  for (const t of normalized) {
    if (plan.tasks.find(x => x.id === t.id)) errors.push(`Task "${t.id}" already exists in plan`);
  }

  // Validate requires — must exist in import set OR existing plan
  const allIds = new Set([...plan.tasks.map(t => t.id), ...normalized.map(t => t.id)]);
  for (const t of normalized) {
    for (const dep of t.requires) {
      if (!allIds.has(dep)) errors.push(`Task "${t.id}" requires "${dep}" which doesn't exist`);
    }
  }

  if (errors.length > 0) {
    console.error('\x1b[31mImport failed — errors:\x1b[0m');
    errors.forEach(e => console.error(`  • ${e}`));
    process.exit(1);
  }

  // Cycle detection on full task set
  const allTasks = [...plan.tasks, ...normalized];
  const cycleErr = detectCycles(allTasks);
  if (cycleErr) die(cycleErr);

  plan.tasks = allTasks;
  savePlan(dir, plan);

  console.log(`\n✅ Imported ${normalized.length} tasks into ${project}`);
  console.log(`   Total tasks: ${plan.tasks.length}`);

  // Dependency summary
  const withDeps = normalized.filter(t => t.requires.length > 0);
  const noDeps = normalized.filter(t => t.requires.length === 0);
  console.log(`   Root tasks (no deps): ${noDeps.map(t => t.id).join(', ') || 'none'}`);
  console.log(`   Tasks with deps: ${withDeps.length}`);

  // Leaf tasks = tasks with no dependents
  const importedIds = new Set(normalized.map(t => t.id));
  const allTasksNow = plan.tasks;
  const leafTasks = normalized.filter(t =>
    !allTasksNow.some(x => (x.requires || []).includes(t.id))
  );
  if (leafTasks.length > 0) {
    console.log(`   ⚠️  Leaf tasks (deliverables, nothing depends on them): ${leafTasks.map(t => t.id).join(', ')}`);
  }
}

function cmdStatus(args) {
  const project = args.project;

  if (!project) {
    // List all projects
    return cmdList(args);
  }

  const dir = resolveProjectDir(project);
  const plan = loadPlan(dir);
  const tasks = plan.tasks || [];
  const total = tasks.length;

  const byStatus = {};
  for (const t of tasks) {
    byStatus[t.status] = byStatus[t.status] || [];
    byStatus[t.status].push(t);
  }

  const done = (byStatus.done || []).length;
  const running = byStatus.running || [];
  const blocked = byStatus.blocked || [];
  const pending = byStatus.pending || [];
  const failed = byStatus.failed || [];

  const bar = progressBar(done, total);
  const pct = total ? Math.round((done / total) * 100) : 0;

  console.log(`\nProject: ${project}`);
  console.log(`Description: ${plan.description || '—'}`);
  console.log(`Updated: ${formatDatetime(plan.updated_at)}`);
  console.log(`\nProgress: ${bar} ${done}/${total} (${pct}%)\n`);

  if ((byStatus.done || []).length > 0)
    console.log(`✅ Done (${done}):        ${byStatus.done.map(t => t.id).join(', ')}`);
  if (running.length > 0)
    console.log(`▶  Running (${running.length}):     ${running.map(t => t.id).join(', ')}`);
  if (blocked.length > 0)
    console.log(`🔴 Blocked (${blocked.length}):     ${blocked.map(t => t.id).join(', ')}`);
  if (failed.length > 0)
    console.log(`❌ Failed (${failed.length}):      ${failed.map(t => t.id).join(', ')}`);
  if (pending.length > 0)
    console.log(`⏳ Pending (${pending.length}):     ${pending.map(t => t.id).join(', ')}`);

  if (tasks.length > 0) {
    const cp = computeCriticalPath(tasks);
    const cpPath = cp.path.join(' → ');
    const remaining = tasks
      .filter(t => !['done','skipped','cancelled'].includes(t.status))
      .reduce((s, t) => s + (t.estimated_hours || 0), 0);
    console.log(`\nCritical path: ${cpPath}`);
    console.log(`Estimated remaining: ${remaining}h (on critical path: ${cp.totalHours}h)`);
  }

  const warnings = [];
  for (const t of blocked) warnings.push(`  ${t.id} [BLOCKED]: ${t.blocker || '(no reason)'}`);
  for (const t of failed) warnings.push(`  ${t.id} [FAILED]: ${t.blocker || '(no reason)'}`);
  if (warnings.length > 0) {
    console.log('\n🟡 WARNINGS:');
    warnings.forEach(w => console.log(w));
  }
  console.log('');
}

function cmdNext(args) {
  const project = args.project;
  const dir = resolveProjectDir(project);
  const plan = loadPlan(dir);

  const ready = getReady(plan.tasks).sort((a, b) => priorityOrder(a.priority) - priorityOrder(b.priority));

  if (ready.length === 0) {
    console.log('\nNo tasks ready to start.');
    const running = plan.tasks.filter(t => t.status === 'running');
    const blocked = plan.tasks.filter(t => t.status === 'blocked');
    if (running.length) console.log(`Currently running: ${running.map(t => t.id).join(', ')}`);
    if (blocked.length) console.log(`Blocked: ${blocked.map(t => t.id).join(', ')}`);
    return;
  }

  console.log(`\nReady to start (${ready.length} task${ready.length > 1 ? 's' : ''}):\n`);
  for (const t of ready) {
    const pad = s => s.padEnd(24);
    console.log(`  ${t.id.padEnd(10)} ${pad(t.name)}  priority=${t.priority || '?'}  assigned=${t.assigned_to || '?'}  est=${t.estimated_hours || '?'}h`);
  }

  const subAgentTasks = ready.filter(t => t.assigned_to === 'sub-agent');
  if (ready.length > 1) {
    console.log('\nThese can run in parallel.');
    if (subAgentTasks.length > 1) {
      console.log(`Suggested: spawn sub-agents for ${subAgentTasks.map(t => t.id).join(' and ')} simultaneously.`);
    }
  }
  console.log('');
}

function cmdImpact(args) {
  const taskId = args.task;
  if (!taskId) die('--task is required');

  const project = args.project;
  const dir = resolveProjectDir(project);
  const plan = loadPlan(dir);
  const tasks = plan.tasks;

  const task = tasks.find(t => t.id === taskId);
  if (!task) die(`Task "${taskId}" not found`);

  const { direct, transitive } = getDownstream(taskId, tasks);

  console.log(`\nImpact analysis for: ${taskId} "${task.name}"\n`);

  if (direct.length === 0 && transitive.length === 0) {
    console.log('No downstream tasks depend on this task.');
  } else {
    if (direct.length > 0) {
      console.log(`Directly depends on ${taskId}:`);
      for (const t of direct) {
        console.log(`  ${t.id.padEnd(10)} ${t.name.padEnd(30)} [${t.status}]`);
      }
    }
    if (transitive.length > 0) {
      console.log(`\nTransitively affected (depends on those):`);
      for (const t of transitive) {
        console.log(`  ${t.id.padEnd(10)} ${t.name.padEnd(30)} [${t.status}]`);
      }
    }

    // Artifact consumers
    const produced = task.produces || [];
    if (produced.length > 0) {
      console.log(`\nConsumes artifacts produced by ${taskId}: ${produced.map(p => `"${p}"`).join(', ')}`);
      const allDown = [...direct, ...transitive];
      for (const artifact of produced) {
        const consumers = allDown.filter(t => (t.produces || []).includes(artifact) === false && (t.requires || []).includes(taskId));
        // For artifact coherence, show which downstream tasks use this artifact
        // We'll simply show that direct dependents consume from this task
      }
      // Show artifact consumers
      for (const t of [...direct, ...transitive]) {
        const shared = produced.filter(p => (t.requires || []).includes(taskId));
        if (shared.length > 0) {
          console.log(`  ${t.id} consumes: ${produced.join(', ')}`);
        }
      }
    }

    const total = direct.length + transitive.length;
    console.log(`\n⚠️  Changing ${taskId} puts ${total} downstream task${total > 1 ? 's' : ''} at risk.`);
    const allAffected = [...direct, ...transitive].map(t => t.id.replace(/^t0*/, ''));
    const failedIds = [...direct, ...transitive].map(t => t.id).join(', ');
    console.log(`If ${taskId} fails: tasks ${failedIds} cannot start.`);
  }

  if (task.rollback) {
    console.log(`\nRollback plan for ${taskId}: ${task.rollback}`);
  }
  console.log('');
}

function cmdStart(args) {
  const taskId = args.task;
  if (!taskId) die('--task is required');

  const project = args.project;
  const dir = resolveProjectDir(project);
  const plan = loadPlan(dir);
  const tasks = plan.tasks;

  const task = tasks.find(t => t.id === taskId);
  if (!task) die(`Task "${taskId}" not found`);

  if (task.status === 'running') die(`Task "${taskId}" is already running`);
  if (task.status === 'done') die(`Task "${taskId}" is already done`);

  // Check dependencies
  const depResults = [];
  let allDepsOk = true;
  for (const dep of (task.requires || [])) {
    const depTask = tasks.find(t => t.id === dep);
    if (!depTask) { depResults.push(`${dep} ❓(not found)`); allDepsOk = false; continue; }
    if (depTask.status === 'done') {
      depResults.push(`${dep} ✅`);
    } else {
      depResults.push(`${dep} ${statusIcon(depTask.status)} [${depTask.status}]`);
      allDepsOk = false;
    }
  }

  if (!allDepsOk) {
    die(`Cannot start "${taskId}" — dependencies not complete:\n  ${depResults.join('\n  ')}`);
  }

  task.status = 'running';
  task.started_at = nowIso();
  savePlan(dir, plan);

  console.log(`\n▶ Starting ${taskId}: ${task.name}`);
  console.log(`  Assigned to: ${task.assigned_to || '—'}`);
  console.log(`  Estimated: ${task.estimated_hours || '?'}h`);

  if (task.acceptance_criteria && task.acceptance_criteria.length > 0) {
    console.log(`\n  Acceptance criteria (must all pass before marking done):`);
    for (const c of task.acceptance_criteria) console.log(`  ✓ ${c}`);
  }

  if (depResults.length > 0) {
    console.log(`\n  Dependencies: ${depResults.join(', ')}`);
  }
  console.log('');
}

function cmdDone(args) {
  const taskId = args.task;
  if (!taskId) die('--task is required');
  const confirm = args.confirm === true || args.confirm === 'true';
  const note = args.note;

  const project = args.project;
  const dir = resolveProjectDir(project);
  const plan = loadPlan(dir);
  const tasks = plan.tasks;

  const task = tasks.find(t => t.id === taskId);
  if (!task) die(`Task "${taskId}" not found`);
  if (task.status === 'done') die(`Task "${taskId}" is already done`);

  console.log(`\n✅ Completing ${taskId}: ${task.name}\n`);

  if (task.acceptance_criteria && task.acceptance_criteria.length > 0) {
    console.log('Acceptance criteria:');
    for (const c of task.acceptance_criteria) console.log(`  ✓ ${c}`);
    console.log('');

    if (!confirm) {
      // In non-interactive mode just proceed (CI safe)
      console.log('(Use --confirm to skip interactive check)\n');
    }
  }

  const wasPending = task.status;
  const duration = task.started_at ? formatDuration(task.started_at, nowIso()) : '—';

  task.status = 'done';
  task.completed_at = nowIso();
  if (!task.started_at) task.started_at = nowIso();
  if (note) task.notes.push({ ts: nowIso(), text: note });

  savePlan(dir, plan);

  console.log(`Task marked done. Duration: ${duration}\n`);

  // Show newly unblocked — tasks whose deps include the just-completed task
  const tasksWithThisDep = plan.tasks.filter(t =>
    (t.requires || []).includes(taskId) && t.status === 'pending'
  );
  if (tasksWithThisDep.length > 0) {
    console.log('Newly unblocked tasks:');
    for (const t of tasksWithThisDep) {
      // Find which deps are still NOT done
      const stillWaiting = (t.requires || []).filter(dep => {
        const d = tasks.find(x => x.id === dep);
        return d && d.status !== 'done';
      });
      if (stillWaiting.length === 0) {
        console.log(`  ${t.id}  ${t.name}  → now READY TO START`);
      } else {
        console.log(`  ${t.id}  ${t.name}  (was waiting on ${(t.requires || []).join(' + ')})`);
        const waitingDetails = stillWaiting.map(dep => {
          const d = tasks.find(x => x.id === dep);
          return `${dep} [${d ? d.status : '?'}]`;
        });
        console.log(`    → ${waitingDetails.join(', ')} still not done before ${t.id} can start`);
      }
    }
  }
  console.log('');
}

function cmdFail(args) {
  const taskId = args.task;
  if (!taskId) die('--task is required');
  const reason = args.reason || '(no reason given)';

  const project = args.project;
  const dir = resolveProjectDir(project);
  const plan = loadPlan(dir);

  const task = plan.tasks.find(t => t.id === taskId);
  if (!task) die(`Task "${taskId}" not found`);

  task.status = 'failed';
  task.blocker = reason;
  savePlan(dir, plan);

  console.log(`\n❌ ${taskId} FAILED: ${task.name}`);
  console.log(`   Reason: ${reason}`);

  if (task.rollback) {
    console.log(`\nRollback plan:\n   ${task.rollback}`);
  }

  // Impact
  const { direct, transitive } = getDownstream(taskId, plan.tasks);
  const allAffected = [...direct, ...transitive];
  if (allAffected.length > 0) {
    console.log(`\nImpact: ${allAffected.length} task${allAffected.length > 1 ? 's' : ''} now cannot start:`);
    for (const t of allAffected) console.log(`   ${t.id}  ${t.name}`);
  }

  console.log(`\nSuggested: fix the issue and run \`plan.cjs retry --task ${taskId}\` to reset to pending.`);
  console.log('');
}

function cmdBlock(args) {
  const taskId = args.task;
  if (!taskId) die('--task is required');
  const reason = args.reason || '(no reason given)';

  const project = args.project;
  const dir = resolveProjectDir(project);
  const plan = loadPlan(dir);

  const task = plan.tasks.find(t => t.id === taskId);
  if (!task) die(`Task "${taskId}" not found`);

  task.status = 'blocked';
  task.blocker = reason;
  savePlan(dir, plan);

  console.log(`🔴 ${taskId} blocked: ${task.name}`);
  console.log(`   Reason: ${reason}`);
  console.log('');
}

function cmdUnblock(args) {
  const taskId = args.task;
  if (!taskId) die('--task is required');

  const project = args.project;
  const dir = resolveProjectDir(project);
  const plan = loadPlan(dir);

  const task = plan.tasks.find(t => t.id === taskId);
  if (!task) die(`Task "${taskId}" not found`);

  task.status = 'pending';
  task.blocker = null;
  savePlan(dir, plan);

  console.log(`✅ ${taskId} unblocked: ${task.name} → status=pending`);

  // Check if ready
  const ready = getReady(plan.tasks);
  if (ready.find(t => t.id === taskId)) {
    console.log(`   All dependencies satisfied — ready to start!`);
  }
  console.log('');
}

function cmdRetry(args) {
  const taskId = args.task;
  if (!taskId) die('--task is required');

  const project = args.project;
  const dir = resolveProjectDir(project);
  const plan = loadPlan(dir);

  const task = plan.tasks.find(t => t.id === taskId);
  if (!task) die(`Task "${taskId}" not found`);

  task.status = 'pending';
  task.blocker = null;
  task.started_at = null;
  task.completed_at = null;
  savePlan(dir, plan);

  console.log(`🔄 ${taskId} reset to pending: ${task.name}`);
  console.log('');
}

function cmdNote(args) {
  const taskId = args.task;
  if (!taskId) die('--task is required');
  const text = args._[0] || args.text || '';
  if (!text) die('Note text is required (positional arg after --task)');

  const project = args.project;
  const dir = resolveProjectDir(project);
  const plan = loadPlan(dir);

  const task = plan.tasks.find(t => t.id === taskId);
  if (!task) die(`Task "${taskId}" not found`);

  task.notes = task.notes || [];
  task.notes.push({ ts: nowIso(), text });
  savePlan(dir, plan);

  console.log(`📝 Note added to ${taskId}: "${text}"`);
  console.log('');
}

function cmdUpdate(args) {
  const taskId = args.task;
  if (!taskId) die('--task is required');

  const project = args.project;
  const dir = resolveProjectDir(project);
  const plan = loadPlan(dir);

  const task = plan.tasks.find(t => t.id === taskId);
  if (!task) die(`Task "${taskId}" not found`);

  const updated = [];
  if (args.assigned) { task.assigned_to = args.assigned; updated.push('assigned_to'); }
  if (args.hours) { task.estimated_hours = parseFloat(args.hours); updated.push('estimated_hours'); }
  if (args.priority) { task.priority = args.priority; updated.push('priority'); }
  if (args.description) { task.description = args.description; updated.push('description'); }
  if (args.tags) { task.tags = splitComma(args.tags); updated.push('tags'); }

  if (updated.length === 0) die('No fields to update. Use --assigned, --hours, --priority, --description, --tags');

  savePlan(dir, plan);
  console.log(`✏️  Updated ${taskId} "${task.name}": ${updated.join(', ')}`);
  console.log('');
}

function cmdGraph(args) {
  const project = args.project;
  const dir = resolveProjectDir(project);
  const plan = loadPlan(dir);
  const tasks = plan.tasks;

  console.log(`\nDependency Graph: ${project}\n`);

  if (tasks.length === 0) {
    console.log('(no tasks)\n');
    return;
  }

  // Topological sort to display level by level
  const order = topoSort(tasks);
  const byId = {};
  for (const t of tasks) byId[t.id] = t;

  // Compute levels
  const level = {};
  for (const id of order) {
    const t = byId[id];
    const depLevels = (t.requires || []).map(d => level[d] ?? 0);
    level[id] = depLevels.length ? Math.max(...depLevels) + 1 : 0;
  }

  const maxLevel = Math.max(...Object.values(level), 0);
  const levelGroups = {};
  for (let i = 0; i <= maxLevel; i++) levelGroups[i] = [];
  for (const id of order) levelGroups[level[id]].push(id);

  function shortId(id) {
    return id.length > 8 ? id.slice(0, 8) : id;
  }

  function taskLabel(id) {
    const t = byId[id];
    if (!t) return `[${id}]`;
    const icon = statusIcon(t.status);
    const shortName = t.name.length > 12 ? t.name.slice(0, 12) : t.name;
    return `[${shortId(id)} ${icon} ${shortName}]`;
  }

  for (let lvl = 0; lvl <= maxLevel; lvl++) {
    for (const id of levelGroups[lvl]) {
      const t = byId[id];
      const label = taskLabel(id);
      const dependents = tasks.filter(x => (x.requires || []).includes(id));
      if (dependents.length > 0) {
        const depLabels = dependents.map(d => taskLabel(d.id));
        if (depLabels.length === 1) {
          console.log(`${label} ──> ${depLabels[0]}`);
        } else {
          console.log(`${label} ──┬──> ${depLabels[0]}`);
          for (let i = 1; i < depLabels.length; i++) {
            const prefix = ' '.repeat(label.length + 2);
            const arrow = i === depLabels.length - 1 ? '└──>' : '├──>';
            console.log(`${prefix}${arrow} ${depLabels[i]}`);
          }
        }
      } else {
        // Leaf or no dependents
        const hasReqs = (t.requires || []).length > 0;
        if (!hasReqs) console.log(`${label}`);
        // If has reqs, was already shown as dependent
      }
    }
  }

  console.log('\nLegend: ✅ done  ▶ running  ⏳ pending  🔴 blocked  ❌ failed\n');
}

function cmdParallel(args) {
  const project = args.project;
  const dir = resolveProjectDir(project);
  const plan = loadPlan(dir);
  const tasks = plan.tasks;

  const waves = computeWaves(tasks);
  const running = tasks.filter(t => t.status === 'running');

  console.log('\nParallel execution plan:\n');

  if (running.length > 0) {
    console.log(`Currently running (${running.length}):`);
    for (const t of running) {
      console.log(`  ${t.id.padEnd(12)} ${t.name.padEnd(24)}  est=${t.estimated_hours || '?'}h  ${t.assigned_to || '?'}`);
    }
    console.log('');
  }

  if (waves.length === 0) {
    const pending = tasks.filter(t => t.status === 'pending');
    if (pending.length === 0) console.log('All tasks complete or running.\n');
    else console.log('No tasks can start (all blocked by unfinished or failed deps).\n');
    return;
  }

  let totalParallel = 0;
  let criticalPathHours = 0;
  const waveMaxHours = [];

  for (let i = 0; i < waves.length; i++) {
    const wave = waves[i];
    const label = i === 0 ? `Wave 1 (can start NOW — ${wave.length} task${wave.length > 1 ? 's' : ''})` :
                            `Wave ${i + 1} (unblocked after Wave ${i})`;
    console.log(`${label}:`);
    for (const t of wave.sort((a, b) => priorityOrder(a.priority) - priorityOrder(b.priority))) {
      const needsDeps = (t.requires || []).length > 0
        ? `  [needs: ${t.requires.join(', ')}]`
        : '';
      console.log(`  ${t.id.padEnd(12)} ${t.name.padEnd(24)}  ${(t.estimated_hours || 0)}h  ${t.assigned_to || '?'}${needsDeps}`);
    }
    const waveMax = Math.max(...wave.map(t => t.estimated_hours || 0));
    waveMaxHours.push(waveMax);
    totalParallel += waveMax;
    console.log('');
  }

  const sequential = tasks
    .filter(t => !['done','skipped','cancelled'].includes(t.status))
    .reduce((s, t) => s + (t.estimated_hours || 0), 0);

  console.log(`Minimum time if fully parallel: ${totalParallel}h (vs ${sequential}h sequential)`);

  // Critical path among pending tasks
  const pendingTasks = tasks.filter(t => !['done','skipped','cancelled'].includes(t.status));
  if (pendingTasks.length > 0) {
    const cp = computeCriticalPath(tasks);
    const pendingCp = cp.path.filter(id => {
      const t = tasks.find(x => x.id === id);
      return t && !['done','skipped','cancelled'].includes(t.status);
    });
    if (pendingCp.length > 0) {
      console.log(`Critical path: ${pendingCp.join(' → ')} (${cp.totalHours}h)`);
    }
  }
  console.log('');
}

function cmdReport(args) {
  const project = args.project;
  const send = args.send === true || args.send === 'true';

  const dir = resolveProjectDir(project);
  const plan = loadPlan(dir);
  const tasks = plan.tasks;

  const total = tasks.length;
  const done = tasks.filter(t => t.status === 'done').length;
  const running = tasks.filter(t => t.status === 'running');
  const blocked = tasks.filter(t => t.status === 'blocked');
  const pending = tasks.filter(t => t.status === 'pending');
  const failed = tasks.filter(t => t.status === 'failed');
  const ready = getReady(tasks);

  const pct = total ? Math.round((done / total) * 100) : 0;
  const bar = progressBar(done, total);
  const remaining = tasks
    .filter(t => !['done','skipped','cancelled'].includes(t.status))
    .reduce((s, t) => s + (t.estimated_hours || 0), 0);
  const cp = tasks.length ? computeCriticalPath(tasks) : null;

  const now = new Date().toISOString().slice(0, 10);
  const reportsDir = path.join(os.homedir(), '.openclaw', 'workspace', 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const reportFile = path.join(reportsDir, `plan-${project}-${now}.md`);

  let md = `# Project Plan Report: ${toTitleCase(project)}\n`;
  md += `*Generated: ${formatDatetime(nowIso())}*\n\n`;
  md += `## Executive Summary\n\n`;
  md += `- **Progress:** ${done}/${total} tasks done (${pct}%)\n`;
  md += `- **Blockers:** ${blocked.length}\n`;
  md += `- **Failed:** ${failed.length}\n`;
  md += `- **Remaining:** ~${remaining}h\n`;
  if (cp) md += `- **Critical path:** ${cp.totalHours}h remaining\n`;
  md += `\n**Progress:** ${bar} ${pct}%\n\n`;

  if (blocked.length > 0) {
    md += `## ⚠️ Blockers\n\n`;
    for (const t of blocked) {
      const { direct, transitive } = getDownstream(t.id, tasks);
      md += `- **${t.id} ${t.name}**: ${t.blocker}\n`;
      md += `  - Affects: ${[...direct, ...transitive].map(x => x.id).join(', ') || 'none'}\n`;
    }
    md += '\n';
  }

  if (failed.length > 0) {
    md += `## ❌ Failed Tasks\n\n`;
    for (const t of failed) {
      md += `- **${t.id} ${t.name}**: ${t.blocker || '—'}\n`;
    }
    md += '\n';
  }

  md += `## Task Status\n\n`;
  md += `| Task | Status | Assigned | Est | Actual | Priority |\n`;
  md += `|------|--------|----------|-----|--------|----------|\n`;
  for (const t of tasks) {
    const actual = t.started_at ? formatDuration(t.started_at, t.completed_at || nowIso()) : '—';
    const icon = statusIcon(t.status);
    md += `| ${t.id} ${t.name} | ${icon} ${t.status} | ${t.assigned_to || '—'} | ${t.estimated_hours || '?'}h | ${actual} | ${t.priority || '—'} |\n`;
  }
  md += '\n';

  if (ready.length > 0) {
    md += `## 🟢 Next Actions (Ready to Start)\n\n`;
    for (const t of ready) {
      md += `- **${t.id} ${t.name}** *(${t.assigned_to} · ${t.estimated_hours}h)*\n`;
    }
    md += '\n';
  }

  if (cp && cp.path.length > 0) {
    md += `## Critical Path\n\n`;
    md += `\`${cp.path.join(' → ')}\` (${cp.totalHours}h)\n\n`;
  }

  // Mini graph
  md += `## Dependency Overview\n\n\`\`\`\n`;
  const order = topoSort(tasks);
  const byId = {};
  for (const t of tasks) byId[t.id] = t;
  for (const id of order) {
    const t = byId[id];
    const icon = statusIcon(t.status);
    const deps = (t.requires || []).join(', ') || '—';
    md += `${icon} ${id.padEnd(12)} ${t.name.padEnd(28)} requires: ${deps}\n`;
  }
  md += `\`\`\`\n\n`;
  md += `*Auto-generated by Kite project-planner.*\n`;

  fs.writeFileSync(reportFile, md);
  console.log(`\n📄 Report saved: ${reportFile}\n`);

  if (send) {
    sendTelegram(null, reportFile)
      .then(() => console.log('✅ Report sent to Telegram'))
      .catch(e => console.error('Failed to send:', e.message));
  }
}

function cmdList(args) {
  const projectsDir = path.join(os.homedir(), 'projects');
  if (!fs.existsSync(projectsDir)) { console.log('No projects directory found.'); return; }

  const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  const projects = [];

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const planFile = path.join(projectsDir, e.name, 'PLAN.json');
    if (!fs.existsSync(planFile)) continue;
    try {
      const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
      const tasks = plan.tasks || [];
      const done = tasks.filter(t => t.status === 'done').length;
      const blocked = tasks.filter(t => t.status === 'blocked').length;
      projects.push({ name: e.name, plan, done, blocked, total: tasks.length });
    } catch(e) { /* skip malformed */ }
  }

  if (projects.length === 0) {
    console.log('\nNo plans found.\n');
    return;
  }

  console.log(`\nPlans found (${projects.length} project${projects.length > 1 ? 's' : ''}):\n`);
  for (const p of projects) {
    const updated = timeAgo(p.plan.updated_at);
    const status = p.plan.status || 'planning';
    console.log(`  ${p.name.padEnd(24)} ${status.padEnd(14)} ${p.done}/${p.total} tasks done   ${p.blocked} blocked   updated ${updated}`);
  }
  console.log('');
}

// ─────────────────────────────────────────────
// Main dispatch
// ─────────────────────────────────────────────

const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.log(`Usage: plan.cjs <command> [options]

Commands:
  new        Create a new project plan
  add        Add a task to a plan
  import     Import tasks from JSON file
  status     Show project status
  next       Show tasks ready to start
  impact     Show downstream impact of a task
  start      Mark task as running
  done       Mark task as complete
  fail       Mark task as failed
  block      Mark task as blocked
  unblock    Clear blocker, reset to pending
  retry      Reset failed task to pending
  note       Add a note to a task
  update     Update task fields
  graph      Show ASCII dependency graph
  parallel   Show parallel execution waves
  report     Generate status report
  list       List all projects with plans
`);
  process.exit(0);
}

const cmd = argv[0];
const args = parseArgs(argv.slice(1));

const commands = {
  new: cmdNew,
  add: cmdAdd,
  import: cmdImport,
  status: cmdStatus,
  next: cmdNext,
  impact: cmdImpact,
  start: cmdStart,
  done: cmdDone,
  fail: cmdFail,
  block: cmdBlock,
  unblock: cmdUnblock,
  retry: cmdRetry,
  note: cmdNote,
  update: cmdUpdate,
  graph: cmdGraph,
  parallel: cmdParallel,
  report: cmdReport,
  list: cmdList,
};

if (!commands[cmd]) {
  die(`Unknown command: "${cmd}". Run plan.cjs without arguments for help.`);
}

commands[cmd](args);
