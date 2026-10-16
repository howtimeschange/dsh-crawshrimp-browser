/** The user's native Full Access preset is a standing grant, not an ask. */
export function nativeFullAccess(ctx, agent) {
  const session = agent?.session
  if (!session) return false
  try {
    const approval = typeof ctx?.get === 'function' ? ctx.get('approval', false) : ctx?.approval
    const sandbox = typeof ctx?.get === 'function' ? ctx.get('sandboxPolicy', false) : ctx?.sandboxPolicy
    return approval?.effectivePolicy?.(session) === 'never'
      && sandbox?.resolve?.({ session })?.mode === 'danger-full-access'
  } catch {
    return false
  }
}
