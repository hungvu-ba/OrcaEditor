{ this paragraph starts with a brace but is not valid JSON }

# Heading

A `{`-leading paragraph is common prose. `JSON.parse` throws on it, so it must
render exactly as it always has: a paragraph, never a front-matter card.
