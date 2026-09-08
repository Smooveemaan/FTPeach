#![no_main]
libfuzzer_sys::fuzz_target!(|data: &[u8]| ftpeach_fuzz::list(data));
