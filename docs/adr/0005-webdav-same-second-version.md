# A WebDAV file changed in the last second is not resumed

A partial WebDAV download resumes only if the file's version is the same as before, and a version read in the second the file last changed is not trusted. HTTP dates have one-second resolution: the file can change again in that second without a new `Last-Modified`, and servers such as nginx build their ETag from that same second. Such a download starts over instead of joining old and new content.
