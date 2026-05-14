from pathlib import Path
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from threading import Thread
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
URL = 'http://127.0.0.1:8765/index.html'


def visible_text(page, selector):
    return page.locator(selector).inner_text(timeout=5000).strip()


def start_game(page, difficulty, expected_level):
    page.goto(URL)
    expect(page.locator('#splashScreen')).to_be_visible()
    page.locator('#splashContinue').click()
    expect(page.locator('#difficultyScreen')).to_be_visible()
    page.locator(f'.difficulty-card[data-difficulty="{difficulty}"]').click()
    expect(page.locator('#guideScreen')).to_be_visible()
    page.locator('#guideSkip').click()
    expect(page.locator('#guideCompleteScreen')).to_be_visible()
    page.locator('#enterTraining').click()
    expect(page.locator('#gameScreen')).to_be_visible()
    expect(page.locator('#hudLevel')).to_have_text(str(expected_level))
    return page


def click_wrong_answer_for_current_question(page):
    alt = page.locator('#shapeImg').get_attribute('alt') or ''
    word = visible_text(page, '#wordText')
    is_match = word in alt
    page.locator('#answerNo' if is_match else '#answerYes').click()


def run_browser_checks():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path='/usr/bin/chromium')
        page = browser.new_page(viewport={"width": 1280, "height": 900})

        # Tutorial interaction: wrong answer gives corrective hint; right answer advances.
        page.goto(URL)
        page.locator('#splashContinue').click()
        page.locator('.difficulty-card[data-difficulty="easy"]').click()
        expect(page.locator('#guideScreen')).to_be_visible()
        expect(page.locator('#guideStepText')).to_have_text('1 / 6')
        page.locator('#guideNo').click()
        expect(page.locator('#guideHint')).to_contain_text('一致')
        page.locator('#guideYes').click()
        expect(page.locator('#guideStepText')).to_have_text('2 / 6')
        page.locator('#guideSkip').click()
        expect(page.locator('#guideCompleteScreen')).to_be_visible()

        # Difficulty start-level checks.
        for difficulty, expected_level in [('easy', 1), ('normal', 15), ('hard', 30)]:
            start_game(page, difficulty, expected_level)
            page.locator('#pauseBtn').click()
            expect(page.locator('#pauseModal')).to_be_visible()
            page.locator('#quitBtn').click()
            expect(page.locator('#difficultyScreen')).to_be_visible()

        # Two consecutive wrong answers should end the sub-level and display summary.
        start_game(page, 'easy', 1)
        page.wait_for_timeout(350)
        click_wrong_answer_for_current_question(page)
        page.wait_for_timeout(650)
        click_wrong_answer_for_current_question(page)
        expect(page.locator('#summaryModal')).to_be_visible(timeout=3000)
        expect(page.locator('#summaryResult')).to_contain_text('连续选错 2 次')

        # Pause help tutorial should return to the same training instead of restarting.
        page.locator('#continueBtn').click()
        page.wait_for_timeout(300)
        before_level = visible_text(page, '#hudLevel')
        page.locator('#pauseBtn').click()
        page.locator('#helpBtn').click()
        expect(page.locator('#guideScreen')).to_be_visible()
        page.locator('#guideSkip').click()
        expect(page.locator('#guideCompleteScreen')).to_be_visible()
        expect(page.locator('#enterTraining')).to_have_text('返回训练')
        page.locator('#enterTraining').click()
        expect(page.locator('#gameScreen')).to_be_visible()
        expect(page.locator('#hudLevel')).to_have_text(before_level)

        browser.close()


def main():
    handler = partial(SimpleHTTPRequestHandler, directory=str(ROOT))
    server = ThreadingHTTPServer(('127.0.0.1', 8765), handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        run_browser_checks()
        print('BROWSER SMOKE PASSED')
    finally:
        server.shutdown()
        thread.join(timeout=2)


if __name__ == '__main__':
    main()
