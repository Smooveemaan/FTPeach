use super::JsonMap;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SavedSite(pub JsonMap);

/// One entry in a full drag-and-drop layout committed by
/// [`Store::apply_layout`].
///
/// Vector order becomes the persisted flat order. `parent_id` is ignored for
/// folders, which are always stored at the root.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteLayoutEntry {
    pub id: String,
    pub parent_id: Option<String>,
}
