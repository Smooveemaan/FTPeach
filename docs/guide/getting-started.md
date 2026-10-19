# Your first transfer

This walkthrough uploads one file from your computer to a server, then explains
how to download a file in the other direction. For a first attempt, use a small,
non-sensitive file with a new name so there is no existing file to replace.

## Before you begin

Download FTPeach from the [official website](https://ftpeach.com/). Choose the
installer for a regular installation, or read [Portable version](portable.md)
if you want to keep the application and its settings together in a folder.

<!-- verified-by: pr test/unit/tooling/siteBuild.test.ts::a release with a portable copy offers both downloads -->

Have these details ready. Your hosting provider or server administrator supplies
them; FTPeach cannot determine your account password or destination folder.

| Detail | What to ask for |
| --- | --- |
| Protocol | FTP, FTPS, SFTP or WebDAV |
| Address and port | The server hostname and port, or the full WebDAV URL |
| Account | Username and password, or the SSH key required for SFTP |
| Destination | The folder where your account is allowed to upload |
| Server identity | For SFTP, the expected host key fingerprint |

## 1. Connect to the server

Keep one pane on **Computer**. At the top of the other pane, click the source
button and choose **Server** to open the connection form. You can use that same
menu to switch a pane back to **Computer**.

[![The Computer source menu, with Server above Computer.](../../site/images/guide/source-menu.png)](../../site/images/guide/source-menu.png)

Choose **Server** in this menu. On the website, click an illustration to enlarge
it over the page. Press **Esc**, click the background or use **Close screenshot**
to return to reading. Without JavaScript, the link opens the image directly.

<!-- verified-by: pr test/visual/website-guide.spec.ts::screenshots enlarge without leaving the guide and restore reading position -->

<!-- verified-by: pr test/component/file-browser/paneSourceSwitcher.test.tsx::the source selector opens a server form and returns to the computer -->

In the connection form, choose the supplied protocol and enter **Address**, **Port**,
**Username** and **Password**, as applicable. Select **Connect**.

[![SFTP connection form with address, port, username and password fields.](../../site/images/guide/connection.png)](../../site/images/guide/connection.png)

Example SFTP form. Replace the sample address and username with your own details.

<!-- verified-by: pr test/component/file-browser/connectionBar.test.tsx::blank addresses disable connecting and saving until filled -->

For SFTP, compare the first host key prompt with the fingerprint supplied by the
administrator before trusting it. If it differs, stop and check with them.
See [Connecting safely](connecting.md#connecting-safely).

<!-- verified-by: pr src-tauri/src/protocol/sftp_tests.rs::local_server_pins_reuses_and_rejects_changed_host_key -->

A successful connection displays the server's folder listing. If that does not
happen, use [Troubleshooting](troubleshooting.md#i-cannot-connect) before trying
to transfer a file.

<!-- verified-by: pr test/unit/file-browser/paneSessionLifecycle.test.ts::a typed-in FTPS server is sent as it is, and becomes connected only after its first listing -->

## 2. Open the source and destination folders

In the computer pane, locate your test file. In the server pane, open the folder
your provider told you to use. Double-click a folder to open it. Check the
destination path before proceeding: connecting to the right server is not the
same as choosing the right folder on it.

<!-- verified-by: pr test/component/file-browser/paneWiring.test.tsx::a folder opens in the pane and a server file opens with its program -->

## 3. Upload the file

Select the file in the computer pane, right-click it and choose **Upload to other
pane**. You can also drag the selection to the server pane. Dropping on the
listing's background uses the currently open destination folder.

<!-- verified-by: pr test/component/file-browser/paneActions.test.ts::the menus follow the order of the Explorer menu -->
<!-- verified-by: pr test/component/file-browser/filePane.test.tsx::starts a pane-to-pane drag with the current multi-selection -->
<!-- verified-by: pr test/component/file-browser/paneWiring.test.tsx::a drop on the listing itself has no target folder -->

If asked about an existing file, check its name and destination before allowing
replacement. For your first transfer, choosing a different test filename avoids
changing anything already on the server.

## 4. Check the result

Look in **Transfers** for the file and its **Route**. Check the final status;
starting a transfer is not evidence that it finished. If it failed, read the
error and follow [Troubleshooting](troubleshooting.md).

[![Transfers panel showing file names, routes, progress and job controls.](../../site/images/guide/transfers.png)](../../site/images/guide/transfers.png)

The transfer panel uses example jobs here; check your own job's status and result.

<!-- verified-by: pr test/component/transfers/transferQueue.test.tsx::direction arrow is pinned before Route and File, while Status stays sortable -->
<!-- verified-by: pr test/component/transfers/transferQueue.test.tsx::queue order puts running and paused rows first, newest within each status, and completed rows last -->

Inspect the destination listing. For a practice run, download the result to a
different local folder and open it to check that it is the file you intended.

## Download a file instead

Open the destination folder in the computer pane. Select a file in the server
pane, right-click and choose **Download to other pane**. Check the route and
result just as you did for the upload.

<!-- verified-by: pr test/component/file-browser/paneActions.test.ts::the menus follow the order of the Explorer menu -->

Next, [save a bookmark](connecting.md#save-a-connection-you-will-use-again), learn
how to [select several files](interface.md), or [edit a remote file](editing.md).
