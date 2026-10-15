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
