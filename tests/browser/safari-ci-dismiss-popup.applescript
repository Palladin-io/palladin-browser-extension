-- Only the opt-in synthetic test on a disposable GitHub-hosted VM invokes this.
tell application "Safari" to activate
tell application "System Events"
    tell application process "Safari"
        key code 53
    end tell
end tell
