-- Escape goes through native Safari UI, only while the known test window is frontmost.
on run arguments
    if (count arguments) is not 1 then return "invalid-test-title"
    set expectedTitle to item 1 of arguments
    if expectedTitle is not "Synthetic extension diagnostics" and expectedTitle is not "Shared unlock test controls" then return "invalid-test-title"
    try
        tell application "System Events"
            tell application process "Safari"
                if frontmost is false then return "safari-not-frontmost"
                if (count windows) is 0 then return "test-window-missing"
                if name of front window does not contain expectedTitle then return "front-window-is-not-test"
                key code 53
            end tell
        end tell
        return "escaped-test-popup"
    on error messageText number errorNumber
        return "native-ui-unavailable"
    end try
end run
