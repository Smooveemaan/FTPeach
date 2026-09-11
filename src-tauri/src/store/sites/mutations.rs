use super::*;

impl Store {
    pub async fn save_site(&self, input: JsonMap) -> Result<SaveSiteOutcome> {
        self.save_site_with_protector(input, Self::protect_secret)
            .await
    }

    pub(crate) async fn save_site_with_protector<F>(
        &self,
        input: JsonMap,
        protect: F,
    ) -> Result<SaveSiteOutcome>
    where
        F: Fn(&[u8]) -> Result<Vec<u8>> + Copy,
    {
        validate_site_input(&input)?;
        let parent_id = parse_parent_id(input.get("parentId"))?;
        let is_local = input.get("kind").and_then(Value::as_str) == Some("local");

        self.ensure_storage_split().await?;
        let path = if is_local {
            self.local_paths_file()
        } else {
            self.sites_file()
        };
        let lock = self.lock_for(&path).await;
        let _guard = lock.lock().await;

        let mut sites: Vec<JsonMap> = self.read_json(&path, Vec::new()).await;
        let id = input
            .get("id")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let idx = sites
            .iter()
            .position(|s| s.get("id").and_then(|v| v.as_str()) == Some(id.as_str()));
        let existing = idx.map(|i| sites[i].clone());
        if let Some(existing) = existing.as_ref()
            && existing.get("kind").and_then(Value::as_str) == Some("folder")
        {
            anyhow::bail!(CommandError::new(
                ErrorCode::InvalidInput,
                "Cannot replace a folder with a site",
            ));
        }
        validate_parent(sites.iter(), &id, None, parent_id.as_deref())?;

        let password = input.get("password").and_then(|v| v.as_str()).unwrap_or("");
        let key_passphrase = input
            .get("keyPassphrase")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let remove_password = input
            .get("removePassword")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let remove_key_passphrase = input
            .get("removeKeyPassphrase")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let (pw_field, password_not_persisted) = if remove_password {
            (None, false)
        } else {
            Self::encrypt_secret_with(password, existing.as_ref(), "enc", "plain", protect)
        };
        let (kp_field, key_passphrase_not_persisted) = if remove_key_passphrase {
            (None, false)
        } else {
            Self::encrypt_secret_with(
                key_passphrase,
                existing.as_ref(),
                "keyEnc",
                "keyPlain",
                protect,
            )
        };

        let mut record = JsonMap::new();
        record.insert("id".into(), Value::String(id.clone()));
        if is_local {
            record.insert("kind".into(), Value::String("local".into()));
            record.insert(
                "name".into(),
                input.get("name").cloned().unwrap_or(Value::Null),
            );
            record.insert(
                "localPath".into(),
                input.get("localPath").cloned().unwrap_or(Value::Null),
            );
            record.insert(
                "parentId".into(),
                parent_id.map(Value::String).unwrap_or(Value::Null),
            );
            for key in ["icon", "color"] {
                record.insert(key.into(), input.get(key).cloned().unwrap_or(Value::Null));
            }
            match idx {
                Some(i) => sites[i] = record,
                None => sites.push(record),
            }
            self.write_json(&path, &sites).await?;
            return Ok(SaveSiteOutcome {
                id,
                secret_not_persisted: false,
            });
        }
        for key in ["name", "icon", "color", "protocol", "host", "port", "user"] {
            record.insert(key.into(), input.get(key).cloned().unwrap_or(Value::Null));
        }
        if let Some(limit) = input.get("maxConnections").or_else(|| {
            existing
                .as_ref()
                .and_then(|site| site.get("maxConnections"))
        }) {
            record.insert("maxConnections".into(), limit.clone());
        }
        record.insert(
            "webdavUrl".into(),
            Value::String(
                input
                    .get("webdavUrl")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .into(),
            ),
        );
        record.insert(
            "secure".into(),
            Value::Bool(
                input
                    .get("secure")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
            ),
        );
        record.insert(
            "allowInvalidCert".into(),
            Value::Bool(
                input
                    .get("allowInvalidCert")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
            ),
        );
        record.insert(
            "remotePath".into(),
            Value::String(
                input
                    .get("remotePath")
                    .and_then(|v| v.as_str())
                    .unwrap_or("/")
                    .into(),
            ),
        );
        record.insert(
            "parentId".into(),
            parent_id.clone().map(Value::String).unwrap_or(Value::Null),
        );
        record.insert(
            "useKeyAuth".into(),
            Value::Bool(
                input
                    .get("useKeyAuth")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
            ),
        );
        record.insert(
            "keyPath".into(),
            Value::String(
                input
                    .get("keyPath")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .into(),
            ),
        );
        record.insert(
            "caCertPath".into(),
            Value::String(
                input
                    .get("caCertPath")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .into(),
            ),
        );
        if let Some((field, value)) = pw_field {
            record.insert(field, value);
        }
        if let Some((field, value)) = kp_field {
            record.insert(field, value);
        }
        if let Some(value) = input.get("hasPassword") {
            record.insert("hasPassword".into(), value.clone());
        }
        if let Some(value) = input.get("hasKeyPassphrase") {
            record.insert("hasKeyPassphrase".into(), value.clone());
        }

        match idx {
            Some(i) => sites[i] = record,
            None => sites.push(record),
        }
        self.write_json(&path, &sites).await?;
        Ok(SaveSiteOutcome {
            id,
            secret_not_persisted: password_not_persisted || key_passphrase_not_persisted,
        })
    }

    pub async fn delete_site(&self, id: &str) -> Result<()> {
        self.ensure_storage_split().await?;
        for path in [self.sites_file(), self.local_paths_file()] {
            let lock = self.lock_for(&path).await;
            let _guard = lock.lock().await;
            let sites: Vec<JsonMap> = self.read_json(&path, Vec::new()).await;
            let Some(entry) = sites
                .iter()
                .find(|s| s.get("id").and_then(Value::as_str) == Some(id))
            else {
                continue;
            };
            if entry.get("kind").and_then(Value::as_str) == Some("folder") {
                anyhow::bail!(CommandError::new(
                    ErrorCode::InvalidInput,
                    "Use the folder delete command to remove a folder",
                ));
            }
            let sites: Vec<JsonMap> = sites
                .into_iter()
                .filter(|s| s.get("id").and_then(|v| v.as_str()) != Some(id))
                .collect();
            return self.write_json(&path, &sites).await;
        }
        Ok(())
    }

    pub async fn save_folder(&self, input: JsonMap) -> Result<String> {
        let name = input
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        validate_name(name, "Folder name is required", "Folder name is too long")?;

        self.ensure_storage_split().await?;
        let is_local_paths =
            input.get("managerScope").and_then(Value::as_str) == Some("localPaths");
        let path = if is_local_paths {
            self.local_paths_file()
        } else {
            self.sites_file()
        };
        let lock = self.lock_for(&path).await;
        let _guard = lock.lock().await;

        let mut entries: Vec<JsonMap> = self.read_json(&path, Vec::new()).await;
        let id = input
            .get("id")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let idx = entries
            .iter()
            .position(|e| e.get("id").and_then(|v| v.as_str()) == Some(id.as_str()));
        if let Some(i) = idx
            && entries[i].get("kind").and_then(Value::as_str) != Some("folder")
        {
            anyhow::bail!(CommandError::new(
                ErrorCode::InvalidInput,
                "Cannot replace a site with a folder",
            ));
        }

        let mut record = JsonMap::new();
        record.insert("id".into(), Value::String(id.clone()));
        record.insert("kind".into(), Value::String("folder".into()));
        record.insert(
            "name".into(),
            input.get("name").cloned().unwrap_or(Value::Null),
        );
        record.insert("parentId".into(), Value::Null);
        if let Some(scope) = input.get("managerScope").and_then(Value::as_str)
            && matches!(scope, "bookmarks" | "localPaths")
        {
            record.insert("managerScope".into(), Value::String(scope.to_string()));
        }

        match idx {
            Some(i) => entries[i] = record,
            None => entries.push(record),
        }
        self.write_json(&path, &entries).await?;
        Ok(id)
    }

    pub async fn delete_folder(&self, id: &str) -> Result<()> {
        self.ensure_storage_split().await?;
        for path in [self.sites_file(), self.local_paths_file()] {
            let lock = self.lock_for(&path).await;
            let _guard = lock.lock().await;
            let mut entries: Vec<JsonMap> = self.read_json(&path, Vec::new()).await;
            let Some(entry) = entries
                .iter()
                .find(|e| e.get("id").and_then(Value::as_str) == Some(id))
            else {
                continue;
            };
            if entry.get("kind").and_then(Value::as_str) != Some("folder") {
                anyhow::bail!(CommandError::new(
                    ErrorCode::InvalidInput,
                    "Use the site delete command to remove a site",
                ));
            }
            let grandparent = entries
                .iter()
                .find(|e| e.get("id").and_then(|v| v.as_str()) == Some(id))
                .and_then(|f| f.get("parentId").cloned())
                .unwrap_or(Value::Null);
            for e in entries.iter_mut() {
                if e.get("parentId").and_then(|v| v.as_str()) == Some(id) {
                    e.insert("parentId".into(), grandparent.clone());
                }
            }
            entries.retain(|e| e.get("id").and_then(|v| v.as_str()) != Some(id));
            return self.write_json(&path, &entries).await;
        }
        Ok(())
    }

    /// Which manager file `layout`'s ids exactly cover.
    async fn layout_target_file(&self, layout: &[SiteLayoutEntry]) -> PathBuf {
        let ids: std::collections::HashSet<&str> = layout.iter().map(|e| e.id.as_str()).collect();
        for path in [self.sites_file(), self.local_paths_file()] {
            let current: Vec<JsonMap> = self.read_json(&path, Vec::new()).await;
            let covers_current = current.len() == layout.len()
                && current.iter().all(|e| {
                    e.get("id")
                        .and_then(Value::as_str)
                        .is_some_and(|id| ids.contains(id))
                });
            if covers_current {
                return path;
            }
        }
        // No exact match — fall back to sites_file() for a precise error below.
        self.sites_file()
    }

    pub async fn apply_layout(&self, layout: Vec<SiteLayoutEntry>) -> Result<()> {
        self.ensure_storage_split().await?;
        let path = self.layout_target_file(&layout).await;
        let lock = self.lock_for(&path).await;
        let _guard = lock.lock().await;
        let current: Vec<JsonMap> = self.read_json(&path, Vec::new()).await;
        let mut by_id: HashMap<String, JsonMap> = current
            .into_iter()
            .filter_map(|e| {
                let id = e.get("id").and_then(Value::as_str).map(str::to_string);
                id.map(|id| (id, e))
            })
            .collect();

        if layout.len() != by_id.len() {
            anyhow::bail!(CommandError::new(
                ErrorCode::InvalidInput,
                "Layout must include every saved entry exactly once",
            ));
        }
        let mut seen = std::collections::HashSet::with_capacity(layout.len());
        for item in &layout {
            if !seen.insert(item.id.as_str()) {
                anyhow::bail!(CommandError::new(
                    ErrorCode::InvalidInput,
                    format!("Duplicate entry id in layout: {}", item.id),
                ));
            }
            if !by_id.contains_key(&item.id) {
                anyhow::bail!(CommandError::new(
                    ErrorCode::InvalidInput,
                    format!("Unknown entry id in layout: {}", item.id),
                ));
            }
        }

        for item in &layout {
            let entry_kind = by_id
                .get(&item.id)
                .and_then(|e| e.get("kind").and_then(Value::as_str));
            validate_parent(
                by_id.values(),
                &item.id,
                entry_kind,
                item.parent_id.as_deref(),
            )?;
        }

        let mut reordered = Vec::with_capacity(layout.len());
        for item in layout {
            let mut record = by_id
                .remove(&item.id)
                .expect("every layout id was validated against by_id above");
            let is_folder = record.get("kind").and_then(Value::as_str) == Some("folder");
            let parent_value = if is_folder {
                Value::Null
            } else {
                item.parent_id.map(Value::String).unwrap_or(Value::Null)
            };
            record.insert("parentId".into(), parent_value);
            reordered.push(record);
        }

        self.write_json(&path, &reordered).await
    }
}
