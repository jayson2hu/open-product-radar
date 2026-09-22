"""Check the real local collection against its report; do not request GitHub again."""
import json
import argparse
import os
from pathlib import Path
from urllib.request import urlopen
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--report', help='Collection JSON; defaults to the latest dated local report')
parser.add_argument('--base', default='http://127.0.0.1:4189')
args = parser.parse_args()
BASE = args.base.rstrip('/')
reports = sorted(Path('artifacts').glob('collection-????-??-??.json'))
if not args.report and not reports:
    parser.error('No collection report found. Run one explicit collection first or pass --report.')
artifact = Path(args.report) if args.report else reports[-1]
output = Path('artifacts') / artifact.stem
report = json.loads(artifact.read_text(encoding='utf-8'))
def get(path):
    with urlopen(BASE + path, timeout=15) as response:
        return json.load(response)

health = get('/api/v1/health')
assert health['mode'] == 'production'
feed = get('/api/v1/feed')
assert feed['stats']['sources'] == feed['collection']['data_source_count'] > 0
assert feed['collection']['counts']['success'] == report.get('collection', {}).get('counts', {}).get('success', report['totals']['repositories'])
assert feed['collection']['counts']['failed'] == len(report['failures'])
if report.get('scheduled_continuously') is False:
    assert next(source for source in feed['collection']['sources'] if source['source_id'] == 'github')['schedule_status'] == 'disabled'
entities = get('/api/v1/entities')['data']
assert len(entities) == report['totals']['repositories'] > 0
for entity in entities:
    original = next(row for row in report['repositories'] if row['id'] == entity['id'])
    assert entity['is_demo'] is False
    assert entity['stars'] == original['stars']
    assert entity['observed_at'] == original['observed_at']
    assert entity['delta_24h'] == original['delta_24h'] and entity['delta_7d'] == original['delta_7d']
errors = []
checks = ['API is real-data mode', 'API matches saved source snapshots', 'No invented growth baseline']
with sync_playwright() as p:
    executable = next((path for path in [os.environ.get('RADAR_BROWSER_PATH'),
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'] if path and Path(path).is_file()), None)
    browser = p.chromium.launch(executable_path=executable, headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 1080}, locale='zh-CN')
    # UI verification must not count its own page views as product usage.
    page.route('**/api/v1/analytics', lambda route: route.fulfill(status=202, content_type='application/json', body='{"ok":true}'))
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(BASE + '/collection.html')
    page.wait_for_load_state('networkidle')
    assert page.locator('.repository').count() == len(entities)
    assert page.locator('.real-badge').inner_text() == '真实采集记录'
    for card, repository in zip(page.locator('.repository').all(), report['repositories']):
        assert card.locator('.stars').inner_text() == f"{repository['stars']:,}"
        assert card.locator('.history').count() == sum(repository[key] is None for key in ['delta_24h', 'delta_7d'])
        assert card.locator('.release').count() == min(3, repository['release_count'])
        for release in card.locator('.release').all():
            assert '待审核' in release.locator('.release-badges').inner_text()
        for link in card.locator('a[target="_blank"]').all():
            assert link.get_attribute('href').startswith('https://github.com/')
    page.screenshot(path=str(output) + '-desktop.png', full_page=True)
    checks.append('Report matches Stars, review state, history and source URLs')
    page.locator('.profile-link').first.click()
    page.wait_for_load_state('networkidle')
    page.locator('.entity-header').wait_for()
    assert report['repositories'][0]['name'] in page.locator('.entity-header').inner_text()
    checks.append('Report links open the matching real project')
    page.goto(BASE + '/#discover')
    page.wait_for_load_state('networkidle')
    page.locator('.repo-row').first.wait_for()
    assert page.locator('.repo-row').count() == len(entities)
    assert page.locator('.demo-label').count() == 0
    status = page.locator('.collection-status-panel')
    assert f'{len(entities)}个成功' in status.inner_text()
    assert '持续采集未启用' in status.inner_text()
    assert page.locator('.collection-result.success').count() == 1
    assert page.locator('.collection-result.attention').count() == 0
    assert page.locator('.repo-rank').count() == 0
    if all(repository['delta_24h'] is None for repository in report['repositories']):
        assert '缺少对照' in page.locator('.growth-explanation').inner_text()
        assert '不会自动' in page.locator('.growth-schedule').first.inner_text()
        assert '非增长排名' in page.locator('.sort-caption').inner_text()
    page.screenshot(path=str(output) + '-app.png', full_page=True)
    checks.append('App shows successful collection separately from disabled scheduling')
    session = get('/api/v1/session')
    if not session['capabilities']['auth']['login_available']:
        page.get_by_role('button', name='登录说明', exact=True).click()
        dialog = page.get_by_role('dialog')
        dialog.wait_for()
        assert dialog.locator('a[href="/api/v1/auth/github"]').count() == 0
        for _ in range(8):
            page.keyboard.press('Tab')
            assert dialog.evaluate('(node) => node.contains(document.activeElement)')
        page.keyboard.press('Escape')
        dialog.wait_for(state='hidden')
        checks.append('Unconfigured login explains available browsing and keeps keyboard focus inside its dialog')
    page.goto(BASE + '/#entity/%')
    page.wait_for_load_state('networkidle')
    page.get_by_role('link', name='返回项目与产品', exact=True).wait_for()
    assert page.locator('.entity-header').count() == 0
    page.goto(BASE + '/#entity/qa-missing-record')
    page.get_by_role('heading', name='没有找到可查看的内容', exact=True).wait_for()
    page.get_by_role('link', name='返回发现页', exact=True).click()
    checks.append('Missing content offers a working recovery link')
    page.goto(BASE + '/#discover')
    page.locator('.repo-row').first.wait_for()
    checks.append('Malformed project link remains recoverable without a blank screen')
    page.set_viewport_size({'width': 390, 'height': 844})
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
    menu = page.get_by_role('button', name='打开导航', exact=True)
    menu.click()
    navigation = page.locator('aside.sidebar')
    for _ in range(10):
        page.keyboard.press('Tab')
        assert navigation.evaluate('(node) => node.contains(document.activeElement)')
    page.keyboard.press('Escape')
    expect(menu).to_have_attribute('aria-expanded', 'false')
    checks.append('Mobile navigation traps focus and restores access after Escape')
    page.screenshot(path=str(output) + '-app-mobile.png', full_page=True, animations='disabled')
    checks.append('390px app collection status has no horizontal overflow')
    page.goto(BASE + '/collection.html')
    page.set_viewport_size({'width': 390, 'height': 844})
    page.wait_for_load_state('networkidle')
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
    page.screenshot(path=str(output) + '-mobile.png', full_page=True)
    checks.append('390px report has no horizontal overflow')
    browser.close()
assert not errors, errors
Path(str(output) + '-verification.json').write_text(json.dumps({
    'status': 'passed', 'checks': checks, 'browser_errors': errors,
    'repositories': len(entities), 'collection_failures': report['failures'],
}, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'status': 'passed', 'checks': len(checks), 'repositories': len(entities)}))
