import test from 'node:test';
import assert from 'node:assert/strict';
import { trendPresentation, scheduleExplanation, loginPresentation, sortingPresentation, productEmptyPresentation } from '../src/presentation.js';

test('first observation explains missing comparison separately for day and week', () => {
  const entity = { kind: 'repository', stars: 100, trend_status: 'insufficient', delta_24h: null, delta_7d: null };
  assert.match(trendPresentation(entity).description, /当前 Star 总量已经采集/);
  assert.match(trendPresentation(entity).description, /24 小时/);
  assert.match(trendPresentation(entity, '7d').description, /7 天/);
  assert.equal(trendPresentation(entity).comparable, false);
  assert.match(scheduleExplanation({ sources: [{ schedule_status: 'disabled' }] }), /不会自动/);
  assert.match(scheduleExplanation({ sources: [{ schedule_status: 'unverified' }] }), /并不保证/);
});

test('display keeps zero and negative growth and evaluates day and week independently', () => {
  const entity = { stars: 100, delta_24h: 0, delta_7d: -12, trend_status: 'insufficient',
    trend_24h: { status: 'comparable' }, trend_7d: { status: 'comparable' } };
  assert.equal(trendPresentation(entity).value, 0);
  assert.equal(trendPresentation(entity, '7d').value, -12);
  entity.trend_24h.status = 'incomparable';
  assert.equal(trendPresentation(entity).comparable, false);
  assert.equal(trendPresentation(entity, '7d').comparable, true);
});

test('production login stays unavailable until the server confirms configuration', () => {
  assert.equal(loginPresentation({ mode: 'production' }).available, false);
  assert.equal(loginPresentation({ mode: 'production', capabilities: { auth: { github_enabled: true, login_available: false } } }).github, false);
  assert.equal(loginPresentation({ mode: 'production', capabilities: { auth: { github_enabled: true, login_available: true } } }).github, true);
  assert.equal(loginPresentation({ mode: 'demo' }).demo, true);
});

test('missing trends are not advertised as a growth ranking', () => {
  const entities = [{ kind: 'repository', stars: 100, trend_status: 'insufficient' }];
  assert.match(sortingPresentation({ effective: 'name' }, entities, '24h', 'repository'), /非增长排名/);
  assert.equal(sortingPresentation({ effective: 'stars' }, entities, '24h', 'repository'), '当前 Star 总量');
});

test('product empty state distinguishes stored repositories from unreviewed releases', () => {
  const empty = productEmptyPresentation({ repositories: 8, products: 0, pending_release_events: 240 }, true);
  assert.match(empty.title, /仓库已采集/);
  assert.match(empty.description, /不会自动生成产品档案/);
  assert.match(empty.nextStep, /240.*待审核/);
});
