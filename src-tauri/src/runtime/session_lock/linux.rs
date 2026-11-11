use dbus::blocking::{Connection, stdintf::org_freedesktop_dbus::Properties};
use std::time::Duration;

pub(super) fn session_locked() -> Option<bool> {
    locked_hint(&Connection::new_system().ok()?)
}

fn locked_hint(connection: &Connection) -> Option<bool> {
    // "auto" also resolves the graphical session for a systemd user service.
    connection
        .with_proxy(
            "org.freedesktop.login1",
            "/org/freedesktop/login1/session/auto",
            Duration::from_millis(250),
        )
        .get("org.freedesktop.login1.Session", "LockedHint")
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use dbus::{MessageType, arg::Variant, channel::Sender};
    use std::io::{BufRead, BufReader};
    use std::process::{Child, Command, Stdio};

    struct TestBus(Child);

    impl Drop for TestBus {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    fn connect(address: &str) -> Connection {
        let mut channel = dbus::channel::Channel::open_private(address).unwrap();
        channel.register().unwrap();
        channel.into()
    }

    #[test]
    fn reads_locked_and_unlocked_hints_and_rejects_missing_service() {
        let mut bus = TestBus(
            Command::new("dbus-daemon")
                .args(["--session", "--nofork", "--print-address=1"])
                .stdout(Stdio::piped())
                .spawn()
                .unwrap(),
        );
        let mut address = String::new();
        BufReader::new(bus.0.stdout.take().unwrap())
            .read_line(&mut address)
            .unwrap();
        let client = connect(address.trim());
        assert_eq!(locked_hint(&client), None);
        let server = connect(address.trim());
        server
            .request_name("org.freedesktop.login1", false, false, false)
            .unwrap();
        let worker = std::thread::spawn(move || {
            for locked in [false, true] {
                let message = loop {
                    let message = server
                        .channel()
                        .blocking_pop_message(Duration::from_secs(2))
                        .unwrap()
                        .unwrap();
                    if message.msg_type() == MessageType::MethodCall {
                        break message;
                    }
                };
                assert_eq!(
                    message.path().unwrap().to_string(),
                    "/org/freedesktop/login1/session/auto"
                );
                let (interface, property): (String, String) = message.read2().unwrap();
                assert_eq!(interface, "org.freedesktop.login1.Session");
                assert_eq!(property, "LockedHint");
                server
                    .send(message.method_return().append1(Variant(locked)))
                    .unwrap();
                server.channel().flush();
            }
        });
        assert_eq!(locked_hint(&client), Some(false));
        assert_eq!(locked_hint(&client), Some(true));
        worker.join().unwrap();
    }
}
