"""Real Web UI identity steps shared by native browser harnesses.
Credentials and recovery words stay in the process/browser; callbacks contain
only fixed scenario labels, never values from the UI.
"""
import re
from urllib.parse import urlsplit


def current_path(browser):
    return urlsplit(browser.request('GET', '/url')).path


def wait_web_unlocked(browser):
    browser.wait(lambda: bool(browser.elements('//a[normalize-space(.)="Vaults"]', 'xpath')), 'unlocked Web')


def register_and_login_web(browser, web_origin, email, password, verify_url, set_stage, record_check):
    set_stage('registration-credentials')
    browser.request('POST', '/url', {'url': web_origin + '/register'})
    for selector, value in [('#register-email', email), ('#register-password', password), ('#register-password-confirm', password)]: browser.fill(selector, value)
    browser.click_button('Continue')
    set_stage('registration-recovery')
    words = browser.wait(lambda: browser.script('const words=[...document.querySelectorAll("ol.ph-no-capture li span.font-mono")].map(e=>e.textContent);return words.length===24?words:null'), 'recovery words')
    browser.click_button("I've Saved My Recovery Key")
    fields = browser.wait(lambda: browser.script('return [...document.querySelectorAll("input[id^=recovery-word-]")].map(e=>e.id)'), 'recovery fields')
    for field in fields: browser.fill('#' + field, words[int(field.split('-')[-1])])
    words.clear()
    set_stage('registration-commit')
    browser.click_button('Verify & Complete Setup')
    verification = browser.wait(verify_url, 'local SES verification', seconds=30)
    record_check('actual-web-registration-with-browser-crypto')
    set_stage('local-email-verification')
    browser.request('POST', '/url', {'url': verification}); verification = None
    browser.wait(lambda: browser.script('return document.body.innerText.includes("Email Verified")'), 'verified email')
    record_check('actual-email-verification-through-local-ses')
    browser.wait(lambda: current_path(browser) != '/verify-email', 'verification navigation')
    set_stage('manual-web-logout')
    if current_path(browser) != '/login': browser.click_button('Log out')
    set_stage('manual-web-login-route')
    browser.wait(lambda: current_path(browser) == '/login', 'login page')
    set_stage('manual-web-login-fields')
    browser.fill('#login-email', email); browser.fill('#login-password', password)
    set_stage('manual-web-login-submit')
    browser.click_button('Sign in')
    set_stage('manual-web-login-completion')
    wait_web_unlocked(browser); record_check('actual-web-manual-password-login')


def create_encrypted_entry(browser, entry_password, set_stage, record_check, *, username='synthetic-entry-user'):
    set_stage('web-create-entry')
    browser.click('//a[normalize-space(.)="Vaults"]', 'xpath')
    browser.click('//*[normalize-space(.)="Personal" and not(.//*[normalize-space(.)="Personal"])]', 'xpath')
    browser.click_button('Add Entry')
    for selector, value in [('#entry-label', 'Synthetic shared unlock proof'), ('#entry-username', username), ('#entry-password', entry_password), ('#entry-url', 'https://shared-unlock-login.example.test')]: browser.fill(selector, value)
    browser.click_button('Save Entry')
    browser.wait(lambda: re.fullmatch(r'/vaults/[^/]+/entries/[^/]+', current_path(browser)), 'created Entry')
    record_check('actual-web-encrypted-entry-created')
    parts = current_path(browser).split('/')
    return parts[2], parts[4]
