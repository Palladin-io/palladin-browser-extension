import { startFirefoxSharedUnlockBridge } from "./transport";

startFirefoxSharedUnlockBridge(window, __PALLADIN_SHARED_UNLOCK_ENVIRONMENTS__, chrome.runtime);
