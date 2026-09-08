use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use minisign_verify::{PublicKey, Signature};
use std::{env, fs};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut arguments = env::args().skip(1);
    let encoded_key = arguments
        .next()
        .ok_or("missing base64-encoded public key")?;
    let artifact = arguments.next().ok_or("missing updater artifact")?;
    let signature = arguments.next().ok_or("missing updater signature")?;
    if arguments.next().is_some() {
        return Err("unexpected extra argument".into());
    }

    let key_text = String::from_utf8(BASE64.decode(encoded_key.trim())?)?;
    let key = PublicKey::decode(&key_text)?;
    let signature_text = String::from_utf8(BASE64.decode(fs::read_to_string(&signature)?.trim())?)?;
    let signature = Signature::decode(&signature_text)?;
    let content = fs::read(&artifact)?;
    key.verify(&content, &signature, false)?;
    println!("Updater signature OK: {artifact}");
    Ok(())
}
