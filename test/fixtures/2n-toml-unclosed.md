+++
title = "This block is never closed"
status = "draft"

# Unclosed TOML fence

US-2.10 deliberately does not autoclose at end-of-document the way `markdown-it-front-matter` does for `---`: nothing above is front matter, so saving this file must not add a closing `+++` the author never typed.
