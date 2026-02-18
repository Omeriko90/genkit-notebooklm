"""
Constants and patterns for the Email Content Extractor Service
"""

import re

# Patterns that indicate "read more" type links
READ_MORE_PATTERNS = [
    r'read\s*more',
    r'continue\s*reading',
    r'full\s*(story|article|post)',
    r'learn\s*more',
    r'see\s*more',
    r'view\s*(full|more|article)',
    r'click\s*here',
    r'more\s*details',
    r'read\s*the\s*(full|rest|entire)',
    r'keep\s*reading',
    r'go\s*to\s*(article|story)',
]

# Compiled regex for performance
READ_MORE_REGEX = re.compile('|'.join(READ_MORE_PATTERNS), re.IGNORECASE)
