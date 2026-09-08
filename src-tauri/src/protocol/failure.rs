/// A failure whose cause the driver already knows, tagged with the code the
/// renderer localizes. Prefer this over `bail!("...")` wherever the cause is
/// known: [`crate::ipc::CommandError::from_anyhow`] reads the code straight
/// back out, so rewording the sentence can't reclassify the failure.
pub fn fail(code: crate::ipc::ErrorCode, message: impl Into<String>) -> anyhow::Error {
    anyhow::Error::new(crate::ipc::CommandError::new(code, message))
}
