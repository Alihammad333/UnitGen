export function emitEvent(type, payload = {}) {
  try {
    console.log(
      "__UNITGEN_EVENT__" +
        JSON.stringify({
          type,
          timestamp: new Date().toISOString(),
          ...payload,
        })
    );
  } catch {
    // Never break pipeline because of UI event
  }
}