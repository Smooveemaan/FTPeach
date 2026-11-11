use super::*;
use dbus::{
    Message, MessageType,
    arg::{RefArg, Variant},
    blocking::Connection as DbusConnection,
    channel::Sender,
};
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

struct TestBus(Child);

type NotifyArguments = (
    String,
    u32,
    String,
    String,
    String,
    Vec<String>,
    HashMap<String, Variant<Box<dyn RefArg>>>,
    i32,
);

impl Drop for TestBus {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn connect(address: &str) -> DbusConnection {
    let mut channel = dbus::channel::Channel::open_private(address).unwrap();
    channel.register().unwrap();
    channel.into()
}

fn next_call(connection: &DbusConnection) -> Message {
    loop {
        let message = connection
            .channel()
            .blocking_pop_message(Duration::from_secs(2))
            .unwrap()
            .unwrap();
        if message.msg_type() == MessageType::MethodCall {
            return message;
        }
    }
}

#[test]
fn notification_identity_click_token_clearing_and_delivery_errors_cross_dbus() {
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
    let server = connect(address.trim());
    server
        .request_name(DESTINATION, false, false, false)
        .unwrap();
    let (clicked, received) = mpsc::channel();
    let client_connection = zbus::blocking::connection::Builder::address(address.trim())
        .unwrap()
        .build()
        .unwrap();
    let client = Client::new(client_connection, move |token| {
        clicked.send(token).unwrap();
    })
    .unwrap();
    let worker = std::thread::spawn(move || {
        let request = next_call(&server);
        assert_eq!(request.member().unwrap(), "Notify");
        let (name, replace, icon, title, body, actions, hints, timeout): NotifyArguments =
            request.read_all().unwrap();
        assert_eq!((name.as_str(), replace), ("FTPeach", 0));
        assert_eq!(
            (icon.as_str(), title.as_str(), body.as_str()),
            ("/icon.png", "Done", "One file")
        );
        assert_eq!(actions, ["default", ""]);
        assert_eq!(hints["desktop-entry"].0.as_str(), Some("FTPeach"));
        assert_eq!(timeout, -1);
        server.send(request.method_return().append1(41u32)).unwrap();
        for message in [
            Message::new_signal(PATH, DESTINATION, "ActionInvoked")
                .unwrap()
                .append2(99u32, "default"),
            Message::new_signal(PATH, DESTINATION, "ActivationToken")
                .unwrap()
                .append2(41u32, "wayland-test-token"),
            Message::new_signal(PATH, DESTINATION, "ActionInvoked")
                .unwrap()
                .append2(41u32, "default"),
        ] {
            server.send(message).unwrap();
        }
        server.channel().flush();
        let close = next_call(&server);
        assert_eq!(close.member().unwrap(), "CloseNotification");
        assert_eq!(close.read1::<u32>().unwrap(), 41);
        server.send(close.method_return()).unwrap();
        server
            .send(
                Message::new_signal(PATH, DESTINATION, "NotificationClosed")
                    .unwrap()
                    .append2(41u32, 3u32),
            )
            .unwrap();
        server.channel().flush();
    });
    client.show("Done", "One file", "/icon.png").unwrap();
    assert_eq!(
        received
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .as_deref(),
        Some("wayland-test-token")
    );
    assert!(
        received.try_recv().is_err(),
        "foreign notifications must not activate FTPeach"
    );
    client.clear().unwrap();
    worker.join().unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    while !lock(&client.shown).is_empty() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(lock(&client.shown).is_empty());
    assert!(client.show("Done", "One file", "/icon.png").is_err());
}
