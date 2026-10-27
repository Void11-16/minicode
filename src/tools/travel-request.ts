/** 旅行工具的网络请求同时响应用户取消和供应商超时。 */
export function cancellableFetch(fetchFn: typeof fetch, signal?: AbortSignal): typeof fetch {
  if (signal === undefined) return fetchFn;
  return (input, init) => {
    signal.throwIfAborted();
    return fetchFn(input, { ...init, signal: init?.signal == null ? signal : AbortSignal.any([signal, init.signal]) });
  };
}
