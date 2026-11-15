p = 'convex/cart.ts'
s = open(p).read()
old = '''    if (!resolved.ok || resolved.candidates.length === 0) {
      throw new ConvexError({
        code: "NO_MATCH",
        message: `Couldn't find a product for "${words}". Try a more specific name or paste the link.`,
      });
    }'''
new = '''    if (!resolved.ok || resolved.candidates.length === 0) {
      // A provider that is down is not a product that does not exist: say which.
      const unavailable = resolved.error !== null && !/no product pages/i.test(resolved.error);
      throw new ConvexError(
        unavailable
          ? {
              code: "UPSTREAM_UNAVAILABLE",
              message: `Product search is unavailable right now. Try again in a moment, or paste the link. (${resolved.error})`,
            }
          : {
              code: "NO_MATCH",
              message: `Couldn't find a product for "${words}". Try a more specific name or paste the link.`,
            },
      );
    }'''
assert old in s
s = s.replace(old, new, 1)
open(p, 'w').write(s)
print("honest resolver failures")
