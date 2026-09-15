import { expect, it } from "vitest";
import { isSurfaceActivity } from "./surface-activity";
import { isBridgeMessage, isWindowEnvelope } from "./protocol";
const activity = { channel: "palladin.session/activity", type: "activity", observedAt: 100 };
it("accepts only the exact private activity message and never the content/page bridge", () => {
  expect(isSurfaceActivity(activity)).toBe(true);
  expect(isBridgeMessage(activity)).toBe(false);
  expect(isWindowEnvelope(activity)).toBe(false);
});
it.each([null, {}, { ...activity, observedAt: -1 }, { ...activity, observedAt: NaN }, { ...activity, observedAt: 1.2 },
  { ...activity, observedAt: "100" }, { ...activity, accountId: "peer" }, { ...activity, type: "ping" }, { ...activity, channel: "page" }])("rejects malformed or widened activity %j", value => {
  expect(isSurfaceActivity(value)).toBe(false);
});
