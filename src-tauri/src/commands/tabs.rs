use crate::ipc::CommandResult;
use crate::store::Store;
use serde_json::Value;
use tauri::State;

#[tauri::command]
pub async fn tabs_get(store: State<'_, Store>) -> CommandResult<Value> {
    Ok(store.get_tabs().await)
}

#[tauri::command]
pub async fn tabs_set(store: State<'_, Store>, state: Value) -> CommandResult<()> {
    store.set_tabs(state).await?;
    Ok(())
}

#[tauri::command]
pub async fn tabs_clear(store: State<'_, Store>) -> CommandResult<()> {
    store.clear_tabs().await?;
    Ok(())
}
