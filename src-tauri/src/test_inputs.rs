//! Inputs for the generated tests of what FTPeach reads back from disk: a
//! valid example changed the way a damaged or hand-edited file would be, from
//! a fixed seed, so a failure repeats.
use rand::rngs::StdRng;
use rand::{RngExt, SeedableRng};
use serde_json::{Value, json};

/// Values that have broken parsers: wrong types, extremes, paths that leave
/// a folder, Windows devices and streams, secrets.
fn odd(rng: &mut StdRng) -> Value {
    let values = [
        Value::Null,
        json!(true),
        json!(-1),
        json!(0),
        json!(2),
        json!(u64::MAX),
        json!(1e300),
        json!(""),
        json!("../.."),
        json!("../../outside.txt"),
        json!("..\\..\\outside.txt"),
        json!("C:\\Windows\\win.ini"),
        json!("\\\\server\\share\\x"),
        json!("CON"),
        json!("a.txt:stream"),
        json!("x".repeat(5000)),
        json!([]),
        json!({}),
        json!({"password": "p"}),
    ];
    values[rng.random_range(0..values.len())].clone()
}

/// `count` variants of `example`, each one to three edits away from it: a
/// value replaced, a key from `keys` added, or a key removed.
pub(crate) fn variants(example: &Value, keys: &[&str], seed: u64, count: usize) -> Vec<Value> {
    let mut rng = StdRng::seed_from_u64(seed);
    (0..count)
        .map(|_| {
            let mut value = example.clone();
            for _ in 0..rng.random_range(1..=3) {
                edit(&mut value, keys, &mut rng);
            }
            value
        })
        .collect()
}

fn edit(value: &mut Value, keys: &[&str], rng: &mut StdRng) {
    let mut node = value;
    loop {
        let children = match &*node {
            Value::Object(map) => map.len(),
            Value::Array(items) => items.len(),
            _ => 0,
        };
        if children == 0 || rng.random_bool(0.3) {
            break;
        }
        let index = rng.random_range(0..children);
        node = match node {
            Value::Object(map) => map.values_mut().nth(index).unwrap(),
            Value::Array(items) => &mut items[index],
            _ => unreachable!(),
        };
    }
    let choice = rng.random_range(0..3);
    match node {
        Value::Object(map) if choice == 0 => {
            map.insert(keys[rng.random_range(0..keys.len())].into(), odd(rng));
        }
        Value::Object(map) if choice == 1 && !map.is_empty() => {
            let key = map
                .keys()
                .nth(rng.random_range(0..map.len()))
                .unwrap()
                .clone();
            map.remove(&key);
        }
        _ => *node = odd(rng),
    }
}

#[cfg(target_os = "linux")]
pub(crate) mod linux {
    use dbus::blocking::Connection;
    use std::io::{BufRead, BufReader};
    use std::process::{Child, Command, Stdio};

    /// Private `dbus-daemon` for Linux tests; killed and reaped on drop.
    pub(crate) struct TestBus {
        child: Child,
        address: String,
    }

    impl TestBus {
        pub(crate) fn start() -> Self {
            let mut child = Command::new("dbus-daemon")
                .args(["--session", "--nofork", "--print-address=1"])
                .stdout(Stdio::piped())
                .spawn()
                .unwrap();
            let mut address = String::new();
            BufReader::new(child.stdout.take().unwrap())
                .read_line(&mut address)
                .unwrap();
            Self {
                child,
                address: address.trim().to_string(),
            }
        }

        pub(crate) fn address(&self) -> &str {
            &self.address
        }

        pub(crate) fn connect(&self) -> Connection {
            let mut channel = dbus::channel::Channel::open_private(&self.address).unwrap();
            channel.register().unwrap();
            channel.into()
        }
    }

    impl Drop for TestBus {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    /// Re-runs the current test inside `xvfb-run` when `guard_env` is unset.
    /// Returns `true` when the parent ran the child and should return early.
    pub(crate) fn run_in_xvfb(test_name: &str, guard_env: &str, require_passed: bool) -> bool {
        if std::env::var_os(guard_env).is_some() {
            return false;
        }
        let output = Command::new("xvfb-run")
            .args(["-a"])
            .arg(std::env::current_exe().unwrap())
            .args(["--exact", test_name, "--nocapture"])
            .env(guard_env, "1")
            .env("GDK_BACKEND", "x11")
            .env_remove("WAYLAND_DISPLAY")
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(output.status.success(), "{stdout}\n{stderr}");
        if require_passed {
            assert!(stdout.contains("1 passed"), "{stdout}\n{stderr}");
        }
        true
    }
}
