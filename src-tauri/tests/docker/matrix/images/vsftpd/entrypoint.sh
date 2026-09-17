#!/bin/sh
set -eu
cat /etc/vsftpd/base.conf /etc/vsftpd/variant.conf >/etc/vsftpd.conf
exec vsftpd /etc/vsftpd.conf
