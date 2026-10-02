import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

test('app.js implements host grouping with collapse state', async () => {
  const appJs = await readFile(
    path.join(import.meta.dirname, '../src/ui/app.js'),
    'utf-8',
  );

  // Verify that the grouping implementation exists
  assert.ok(
    appJs.includes('collapsedHosts'),
    'State should track collapsed hosts',
  );
  assert.ok(
    appJs.includes('toggleHostGroup'),
    'Should have toggleHostGroup function',
  );
  assert.ok(
    appJs.includes('host-group-header'),
    'Should render host group headers',
  );
  assert.ok(
    appJs.includes('host-group-count'),
    'Should show request count per host',
  );
  assert.ok(
    appJs.includes('aria-expanded'),
    'Host headers should have aria-expanded for accessibility',
  );

  // Verify grouping logic
  assert.ok(
    appJs.includes('hostGroups') && appJs.includes('new Map()'),
    'Should use Map to group sessions by host',
  );
  assert.ok(
    appJs.includes('mostRecent'),
    'Should track most recent request per host for ordering',
  );
  assert.ok(
    appJs.includes('sort') && appJs.match(/sort.*startedAt/s),
    'Should sort requests by timestamp',
  );

  // Verify collapse/expand toggle logic
  assert.ok(
    appJs.includes('isCollapsed'),
    'Should check if host group is collapsed',
  );
  assert.ok(
    appJs.match(/▸|▾/),
    'Should use visual indicators for collapsed/expanded state',
  );

  // Verify selection is preserved
  assert.ok(
    appJs.includes('state.selected?.id === session.id'),
    'Should preserve selected session across re-renders',
  );
});

test('styles.css includes host group header styles', async () => {
  const css = await readFile(
    path.join(import.meta.dirname, '../src/ui/styles.css'),
    'utf-8',
  );

  assert.ok(
    css.includes('.host-group-header'),
    'Should have styles for host group headers',
  );
  assert.ok(
    css.includes('.host-group-toggle'),
    'Should have styles for collapse/expand toggle',
  );
  assert.ok(
    css.includes('.host-group-name'),
    'Should have styles for host name',
  );
  assert.ok(
    css.includes('.host-group-count'),
    'Should have styles for request count badge',
  );
  assert.ok(
    css.includes('sticky'),
    'Host headers should be sticky for better UX',
  );
});
