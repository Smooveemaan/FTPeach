# The app animates whatever the system motion setting says

The application has no `prefers-reduced-motion` rules: its fades and transitions run even with Windows animation effects turned off. Under the old global rule, status notices and settings errors vanished at once, before anyone could read them. What must not move, such as the selection rectangle under the pointer, gets no transition at all rather than a media query. The website is separate and does honor reduced motion.
