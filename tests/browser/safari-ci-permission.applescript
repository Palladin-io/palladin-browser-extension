-- Only invoked by the explicit GitHub-hosted CI flag, for the synthetic fixture.
-- Match both the fixture name and loopback host before clicking the native grant.
try
    tell application "System Events"
        tell application process "Safari"
            repeat 40 times
                repeat with candidateWindow in windows
                    set elements to entire contents of candidateWindow
                    set fixtureMatched to false
                    set hostMatched to false
                    repeat with candidate in elements
                        try
                            if role of candidate is "AXStaticText" then
                                set labelText to value of candidate as text
                                if labelText contains "Synthetic shared unlock boundary" then set fixtureMatched to true
                                if labelText contains "127.0.0.1" then set hostMatched to true
                            end if
                        end try
                    end repeat
                    if fixtureMatched and hostMatched then
                        repeat with candidate in elements
                            try
                                if role of candidate is "AXButton" and name of candidate is "Allow for One Day" then
                                    click candidate
                                    return "granted-fixture-for-one-day"
                                end if
                            end try
                        end repeat
                    end if
                end repeat
                delay 0.25
            end repeat
        end tell
    end tell
    return "fixture-prompt-not-found"
on error messageText number errorNumber
    return "native-ui-error:" & errorNumber
end try
