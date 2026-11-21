use super::*;
use crate::test_inputs::linux::TestBus;
use dbus::{
    Message, MessageType,
    arg::{RefArg, Variant},
    blocking::Connection as DbusConnection,
    channel::Sender,
};
use std::sync::mpsc;
use std::time::{Duration, Instant};

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

fn start_notification_bus() -> (TestBus, DbusConnection, zbus::blocking::Connection) {
    let bus = TestBus::start();
    let server = bus.connect();
    server
        .request_name(DESTINATION, false, false, false)
        .unwrap();
    let connection = zbus::blocking::connection::Builder::address(bus.address())
        .unwrap()
        .build()
        .unwrap();
    (bus, server, connection)
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
    let (_bus, server, client_connection) = start_notification_bus();
    let (clicked, received) = mpsc::channel();
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

#[test]
fn clearing_continues_when_the_server_rejects_one_notification() {
    let (_bus, server, connection) = start_notification_bus();
    let client = Client::new(connection, |_| panic!("clearing must not activate the app")).unwrap();
    let worker = std::thread::spawn(move || {
        for id in [41u32, 42] {
            let request = next_call(&server);
            assert_eq!(request.member().unwrap(), "Notify");
            server.send(request.method_return().append1(id)).unwrap();
        }
        let rejected = next_call(&server);
        assert_eq!(rejected.member().unwrap(), "CloseNotification");
        let rejected_id = rejected.read1::<u32>().unwrap();
        server
            .send(rejected.error(
                &"org.freedesktop.Notifications.InvalidId".into(),
                c"Notification already dismissed",
            ))
            .unwrap();
        let remaining = next_call(&server);
        assert_eq!(remaining.member().unwrap(), "CloseNotification");
        let remaining_id = remaining.read1::<u32>().unwrap();
        assert_ne!(rejected_id, remaining_id);
        assert!([41, 42].contains(&remaining_id));
        server.send(remaining.method_return()).unwrap();
    });
    client.show("Done", "One file", "/icon.png").unwrap();
    client.show("Done", "Another file", "/icon.png").unwrap();
    assert!(
        client.clear().is_err(),
        "delivery errors must remain observable"
    );
    worker.join().unwrap();
}
