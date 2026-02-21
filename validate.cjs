#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

function resolvePath(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function resolveProjectDir(project) {
  if (!project) { console.error('Error: --project is required'); process.exit(1); }
  if (project.includes('/') || project.includes('\\')) return resolvePath(project);
  return path.join(os.homedir(), 'projects', project);
}

function parseArgs(argv) {
  const args = {};
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) { args[key] = argv[i + 1]; i += 2; }
      else { args[key] = true; i++; }
    } else { i++; }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const project = args.project;
const dir = resolveProjectDir(project);
const planFile = path.join(dir, 'PLAN.json');

if (!fs.existsSync(planFile)) {
  console.error(`Error: No PLAN.json found at ${planFile}`);
  process.exit(1);
}

let plan;
try { plan = JSON.parse(fs.readFileSync(planFile, 'utf8')); }
catch (e) { console.error(`Error: Invalid JSON in PLAN.json: ${e.message}`); process.exit(1); }

const tasks = plan.tasks || [];
const errors = [];
const warnings = [];

// 1. No duplicate task IDs
const seenIds = new Set();
for (const t of tasks) {
  if (!t.id) { errors.push(`Task missing "id" field`); continue; }
  if (seenIds.has(t.id)) {
    errors.push(`Duplicate task ID: "${t.id}"`);
  }
  seenIds.add(t.id);
}

// 2. All requires IDs exist
for (const t of tasks) {
  for (const dep of (t.requires || [])) {
    if (!seenIds.has(dep)) {
      errors.push(`Task "${t.id}" requires "${dep}" which does not exist in plan`);
    }
  }
}

// 3. No circular dependencies (DFS)
const byId = {};
for (const t of tasks) byId[t.id] = t;
const WHITE = 0, GRAY = 1, BLACK = 2;
const color = {};
for (const t of tasks) color[t.id] = WHITE;

function dfs(id, stack) {
  if (!byId[id]) return null;
  color[id] = GRAY;
  for (const dep of (byId[id].requires || [])) {
    if (color[dep] === GRAY) {
      return `Cycle detected: ${[...stack, dep].join(' → ')}`;
    }
    if (color[dep] === WHITE) {
      const err = dfs(dep, [...stack, dep]);
      if (err) return err;
    }
  }
  color[id] = BLACK;
  return null;
}

for (const t of tasks) {
  if (color[t.id] === WHITE) {
    const err = dfs(t.id, [t.id]);
    if (err) errors.push(err);
  }
}

// 4. All tasks have at least one acceptance criterion
for (const t of tasks) {
  const crit = t.acceptance_criteria || [];
  if (crit.length === 0) {
    errors.push(`Task "${t.id}" (${t.name || '?'}) has no acceptance criteria`);
  }
}

// 5. Produces-requires coherence
// For each task that requires another, check if the required task produces the needed artifacts
// This is advisory — warns but doesn't error
const allProduced = {}; // artifact -> [taskId]
for (const t of tasks) {
  for (const a of (t.produces || [])) {
    allProduced[a] = allProduced[a] || [];
    allProduced[a].push(t.id);
  }
}

// Check for any artifacts mentioned in names/descriptions but not produced
// (This is lightweight — we just check required tasks actually produce something)
for (const t of tasks) {
  for (const dep of (t.requires || [])) {
    const depTask = byId[dep];
    if (depTask && (depTask.produces || []).length === 0) {
      warnings.push(`Task "${t.id}" requires "${dep}" but "${dep}" produces no artifacts (advisory)`);
    }
  }
}

// 6. Tasks with no name
for (const t of tasks) {
  if (!t.name) errors.push(`Task "${t.id}" has no name`);
}

// Report
console.log(`\nValidating: ${project} (${tasks.length} tasks)\n`);

if (errors.length === 0) {
  console.log('✅ VALID — no errors found');
  if (warnings.length > 0) {
    console.log(`\n⚠️  Warnings (${warnings.length}):`);
    warnings.forEach(w => console.log(`  • ${w}`));
  }
} else {
  console.log(`❌ INVALID — ${errors.length} error${errors.length > 1 ? 's' : ''} found:\n`);
  errors.forEach(e => console.log(`  • ${e}`));
  if (warnings.length > 0) {
    console.log(`\n⚠️  Warnings (${warnings.length}):`);
    warnings.forEach(w => console.log(`  • ${w}`));
  }
  process.exit(1);
}
console.log('');
