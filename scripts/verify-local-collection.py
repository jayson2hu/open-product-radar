"""Check the real local collection against its report; do not request GitHub again."""
import json
from pathlib import Path
from urllib.request import urlopen
from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:4189'
artifact = Path('artifacts/collection-2026-09-22.json')
report = json.loads(artifact.read_text(encoding='utf-8'))
def get(path):
    with urlopen(BASE + path) as response:
        return json.load(response)

health = get('/api/v1/health')
assert health['mode'] == 'production'
feed = get('/api/v1/feed')
assert feed['stats']['sources'] == 1
assert feed['collection']['counts']['success'] == report['totals']['repositories']
assert feed['collection']['counts']['failed'] == len(report['failures'])
assert feed['collection']['sources'][0]['schedule_status'] == 'disabled'
entities = get('/api/v1/entities')['data']
assert len(entities) == report['totals']['repositories'] > 0
for entity in entities:
    original = next(row for row in report['repositories'] if row['id'] == entity['id'])
    assert entity['is_demo'] is False
    assert entity['stars'] == original['stars']
    assert entity['observed_at'] == original['observed_at']
    assert entity['delta_24h'] is None and entity['delta_7d'] is None
errors = []
checks = ['API is real-data mode', 'API matches saved source snapshots', 'No invented growth baseline']
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='C:/Program Files/Google/Chrome/Application/chrome.exe', headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 1080}, locale='zh-CN')
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(BASE + '/collection.html')
    page.wait_for_load_state('networkidle')
    assert page.locator('.repository').count() == len(entities)
    assert page.locator('.real-badge').inner_text() == '真实采集记录'
    for card, repository in zip(page.locator('.repository').all(), report['repositories']):
        assert card.locator('.stars').inner_text() == f"{repository['stars']:,}"
        assert card.locator('.history').count() == 2
        assert card.locator('.release').count() == min(3, repository['release_count'])
        for release in card.locator('.release').all():
            assert '待审核' in release.locator('.release-badges').inner_text()
        for link in card.locator('a[target="_blank"]').all():
            assert link.get_attribute('href').startswith('https://github.com/')
    page.screenshot(path='artifacts/collection-2026-09-22-desktop.png', full_page=True)
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
    page.screenshot(path='artifacts/collection-2026-09-22-app.png', full_page=True)
    checks.append('App shows successful collection separately from disabled scheduling')
    page.set_viewport_size({'width': 390, 'height': 844})
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
    page.screenshot(path='artifacts/collection-2026-09-22-app-mobile.png', full_page=True)
    checks.append('390px app collection status has no horizontal overflow')
    page.goto(BASE + '/collection.html')
    page.set_viewport_size({'width': 390, 'height': 844})
    page.wait_for_load_state('networkidle')
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
    page.screenshot(path='artifacts/collection-2026-09-22-mobile.png', full_page=True)
    checks.append('390px report has no horizontal overflow')
    browser.close()
assert not errors, errors
Path('artifacts/collection-2026-09-22-verification.json').write_text(json.dumps({
    'status': 'passed', 'checks': checks, 'browser_errors': errors,
    'repositories': len(entities), 'collection_failures': report['failures'],
}, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'status': 'passed', 'checks': len(checks), 'repositories': len(entities)}))
