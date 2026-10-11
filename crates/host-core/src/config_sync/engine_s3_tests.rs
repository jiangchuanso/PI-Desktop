use super::tests::{
    configure_test_device, configure_test_device_mode, pending_approvals, run_in_isolated_process,
};
use super::*;
use crate::config_sync::transport::tests::fixture;

fn theme(state: &AppState) -> Result<Value> {
    Ok(state.db.get_setting("app")?.unwrap_or_else(|| json!({}))["theme"].clone())
}

async fn approve_all(
    state: &Arc<Mutex<AppState>>,
    tx: &mpsc::UnboundedSender<String>,
) -> Result<()> {
    let value = get_state(state.clone()).await?;
    for (id, digest, _) in pending_approvals(&value) {
        approve(
            state.clone(),
            json!({"approvalId":id,"digest":digest}),
            tx.clone(),
        )
        .await?;
    }
    assert!(pending_approvals(&get_state(state.clone()).await?).is_empty());
    Ok(())
}

#[test]
fn unconfigured_device_uses_s3_defaults() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let mut state = AppState::open(directory.path())?;
    let public = public_state(&mut state)?;
    assert_eq!(public["configured"], false);
    assert_eq!(public["mode"], "sync");
    assert_eq!(public["pathStyle"], true);
    assert!(load_config(&state)?.is_none());
    Ok(())
}

#[tokio::test]
async fn backup_does_not_apply_remote_settings_and_restore_is_local_only() -> Result<()> {
    if run_in_isolated_process(
        "config_sync::engine::s3_tests::backup_does_not_apply_remote_settings_and_restore_is_local_only",
    )? {
        return Ok(());
    }
    let fixture = fixture(false).await;
    let directory_a = tempfile::tempdir()?;
    let directory_b = tempfile::tempdir()?;
    let device_a = configure_test_device(directory_a.path(), &fixture.endpoint).await?;
    let device_b =
        configure_test_device_mode(directory_b.path(), &fixture.endpoint, "backup").await?;
    device_a
        .lock()
        .await
        .db
        .set_setting("app", &json!({"theme":"light"}))?;
    device_b
        .lock()
        .await
        .db
        .set_setting("app", &json!({"theme":"dark"}))?;
    let (tx, _rx) = mpsc::unbounded_channel();
    let sync_revision = sync_now(device_a.clone(), tx.clone()).await?["lastRevisionId"].clone();
    let first_backup = sync_now(device_b.clone(), tx.clone()).await?["lastRevisionId"].clone();
    assert_eq!(theme(&*device_b.lock().await)?, "dark");
    assert_eq!(
        list_history(device_a.clone()).await?[0]["revisionId"],
        sync_revision
    );
    assert_eq!(
        list_history(device_b.clone()).await?[0]["revisionId"],
        first_backup
    );
    device_b
        .lock()
        .await
        .db
        .set_setting("app", &json!({"theme":"system"}))?;
    let second_backup = sync_now(device_b.clone(), tx.clone()).await?["lastRevisionId"].clone();
    assert_ne!(first_backup, second_backup);
    restore(
        device_b.clone(),
        json!({"revisionId": first_backup}),
        tx.clone(),
    )
    .await?;
    assert_eq!(theme(&*device_b.lock().await)?, "dark");
    assert_eq!(
        list_history(device_b.clone()).await?[0]["revisionId"],
        second_backup
    );
    assert_eq!(
        list_history(device_a.clone()).await?[0]["revisionId"],
        sync_revision
    );
    sync_now(device_a.clone(), tx).await?;
    assert_eq!(theme(&*device_a.lock().await)?, "light");
    assert!(!load_config(&*device_b.lock().await)?
        .unwrap()
        .recovery_points
        .is_empty());
    Ok(())
}

#[tokio::test]
async fn sync_restore_requires_acknowledgement_and_propagates_as_a_new_revision() -> Result<()> {
    if run_in_isolated_process(
        "config_sync::engine::s3_tests::sync_restore_requires_acknowledgement_and_propagates_as_a_new_revision",
    )? {
        return Ok(());
    }
    let fixture = fixture(false).await;
    let directory_a = tempfile::tempdir()?;
    let directory_b = tempfile::tempdir()?;
    let device_a = configure_test_device(directory_a.path(), &fixture.endpoint).await?;
    let device_b = configure_test_device(directory_b.path(), &fixture.endpoint).await?;
    let (tx, _rx) = mpsc::unbounded_channel();
    device_a
        .lock()
        .await
        .db
        .set_setting("app", &json!({"theme":"light"}))?;
    let first = sync_now(device_a.clone(), tx.clone()).await?["lastRevisionId"].clone();
    sync_now(device_b.clone(), tx.clone()).await?;
    device_a
        .lock()
        .await
        .db
        .set_setting("app", &json!({"theme":"dark"}))?;
    sync_now(device_a.clone(), tx.clone()).await?;
    sync_now(device_b.clone(), tx.clone()).await?;
    assert_eq!(theme(&*device_b.lock().await)?, "dark");
    assert!(
        restore(device_a.clone(), json!({"revisionId":first}), tx.clone())
            .await
            .is_err()
    );
    assert_eq!(theme(&*device_a.lock().await)?, "dark");
    let restored = restore(
        device_a.clone(),
        json!({"revisionId":first,"acknowledgePropagation":true}),
        tx.clone(),
    )
    .await?;
    assert_ne!(restored["lastRevisionId"], first);
    assert_eq!(theme(&*device_a.lock().await)?, "light");
    sync_now(device_b.clone(), tx).await?;
    assert_eq!(theme(&*device_b.lock().await)?, "light");
    Ok(())
}

#[tokio::test]
async fn credentials_opt_out_survives_approval_and_remote_deletion_converges() -> Result<()> {
    if run_in_isolated_process(
        "config_sync::engine::s3_tests::credentials_opt_out_survives_approval_and_remote_deletion_converges",
    )? {
        return Ok(());
    }
    let fixture = fixture(false).await;
    let directory_a = tempfile::tempdir()?;
    let directory_b = tempfile::tempdir()?;
    let device_a = configure_test_device(directory_a.path(), &fixture.endpoint).await?;
    let device_b = configure_test_device(directory_b.path(), &fixture.endpoint).await?;
    configure(device_b.clone(), json!({"includeSecrets":false})).await?;
    let provider_id =
        {
            let state = device_a.lock().await;
            providers::create_provider(&state.db, &state.secrets, serde_json::from_value(json!({
            "name":"S3 regression", "type":"openai_compatible", "protocol":"openai_compatible",
            "baseUrl":"https://provider.example.test/v1", "authKind":"api_key_and_base_url",
            "secretValue":"source-only-key", "models":[]
        }))?)?.id
        };
    let (tx, _rx) = mpsc::unbounded_channel();
    sync_now(device_a.clone(), tx.clone()).await?;
    let received = sync_now(device_b.clone(), tx.clone()).await?;
    assert!(!pending_approvals(&received).is_empty());
    {
        let state = device_b.lock().await;
        assert!(providers::get_provider(&state.db, &state.secrets, &provider_id)?.is_none());
    }
    approve_all(&device_b, &tx).await?;
    {
        let state = device_b.lock().await;
        let imported = providers::get_provider(&state.db, &state.secrets, &provider_id)?.unwrap();
        assert!(!imported.has_secret);
        assert!(!imported.enabled);
    }
    // The publishing device acknowledges the receiver's secret-free metadata
    // before deletion, without losing its own device-local credential.
    sync_now(device_a.clone(), tx.clone()).await?;
    approve_all(&device_a, &tx).await?;
    {
        let state = device_a.lock().await;
        assert!(
            providers::get_provider(&state.db, &state.secrets, &provider_id)?
                .unwrap()
                .has_secret
        );
        providers::delete_provider(&state.db, &state.secrets, &provider_id)?;
    }
    sync_now(device_a.clone(), tx.clone()).await?;
    sync_now(device_b.clone(), tx.clone()).await?;
    approve_all(&device_b, &tx).await?;
    for _ in 0..2 {
        sync_now(device_b.clone(), tx.clone()).await?;
        sync_now(device_a.clone(), tx.clone()).await?;
    }
    let state = device_b.lock().await;
    assert!(providers::get_provider(&state.db, &state.secrets, &provider_id)?.is_none());
    Ok(())
}

#[tokio::test]
async fn resource_updates_and_packaged_skill_deletion_reach_the_other_device() -> Result<()> {
    if run_in_isolated_process(
        "config_sync::engine::s3_tests::resource_updates_and_packaged_skill_deletion_reach_the_other_device",
    )? {
        return Ok(());
    }
    let fixture = fixture(false).await;
    let directory_a = tempfile::tempdir()?;
    let directory_b = tempfile::tempdir()?;
    let device_a = configure_test_device(directory_a.path(), &fixture.endpoint).await?;
    let device_b = configure_test_device(directory_b.path(), &fixture.endpoint).await?;
    let project_a = directory_a.path().join("project");
    let project_b = directory_b.path().join("project");
    fs::create_dir_all(&project_a)?;
    fs::create_dir_all(&project_b)?;
    let project_a = project_a.canonicalize()?.to_string_lossy().into_owned();
    let project_b = project_b.canonicalize()?.to_string_lossy().into_owned();
    {
        let mut state = device_a.lock().await;
        state.db.ensure_project(&project_a, false)?;
        state
            .user_skills
            .create(crate::user_skills::UserSkillInput {
                id: Some("changing-skill".into()),
                name: Some("Changing skill".into()),
                level: Some("project".into()),
                project_path: Some(project_a.clone()),
                body: Some("Fixture instructions".into()),
                shape: Some("dir".into()),
                ..Default::default()
            })?;
        state.user_skills.write_package_files(
            "changing-skill",
            CapabilityLevel::Project,
            Some(&project_a),
            &[("data.txt".into(), b"first".to_vec())],
        )?;
    }
    let (tx, _rx) = mpsc::unbounded_channel();
    sync_now(device_a.clone(), tx.clone()).await?;
    let received = sync_now(device_b.clone(), tx.clone()).await?;
    let mapping = received["pendingApprovals"]
        .as_array()
        .unwrap()
        .iter()
        .find_map(|item| item["mappingKey"].as_str())
        .unwrap();
    map_project(
        device_b.clone(),
        json!({"logicalId":mapping,"paths":[project_b]}),
    )
    .await?;
    approve_all(&device_b, &tx).await?;
    {
        let mut state = device_a.lock().await;
        let skill = state
            .user_skills
            .list(CapabilityLevel::Project, Some(&project_a))?
            .remove(0);
        fs::write(
            Path::new(&skill.path).parent().unwrap().join("data.txt"),
            b"updated",
        )?;
    }
    sync_now(device_a.clone(), tx.clone()).await?;
    sync_now(device_b.clone(), tx.clone()).await?;
    approve_all(&device_b, &tx).await?;
    {
        let mut state = device_b.lock().await;
        assert_eq!(
            state.user_skills.package_files(
                "changing-skill",
                CapabilityLevel::Project,
                Some(&project_b)
            )?,
            vec![("data.txt".into(), b"updated".to_vec())]
        );
    }
    device_a.lock().await.user_skills.remove(
        "changing-skill",
        Some(CapabilityLevel::Project),
        Some(&project_a),
    )?;
    sync_now(device_a.clone(), tx.clone()).await?;
    sync_now(device_b.clone(), tx.clone()).await?;
    approve_all(&device_b, &tx).await?;
    assert!(device_b
        .lock()
        .await
        .user_skills
        .list(CapabilityLevel::Project, Some(&project_b))?
        .is_empty());
    sync_now(device_b.clone(), tx).await?;
    Ok(())
}

#[tokio::test]
async fn chosen_conflict_is_published_without_reopening_old_candidates() -> Result<()> {
    if run_in_isolated_process(
        "config_sync::engine::s3_tests::chosen_conflict_is_published_without_reopening_old_candidates",
    )? {
        return Ok(());
    }
    let fixture = fixture(false).await;
    let directory_a = tempfile::tempdir()?;
    let directory_b = tempfile::tempdir()?;
    let a = configure_test_device(directory_a.path(), &fixture.endpoint).await?;
    let b = configure_test_device(directory_b.path(), &fixture.endpoint).await?;
    let (tx, _rx) = mpsc::unbounded_channel();
    a.lock()
        .await
        .db
        .set_setting("app", &json!({"theme":"dark"}))?;
    sync_now(a.clone(), tx.clone()).await?;
    sync_now(b.clone(), tx.clone()).await?;
    a.lock()
        .await
        .db
        .set_setting("app", &json!({"theme":"light"}))?;
    b.lock()
        .await
        .db
        .set_setting("app", &json!({"theme":"system"}))?;
    sync_now(a.clone(), tx.clone()).await?;
    let conflict = sync_now(b.clone(), tx.clone()).await?;
    let item = conflict["pendingApprovals"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["entityId"].as_str().unwrap().ends_with(":local"))
        .unwrap();
    approve(
        b.clone(),
        json!({"approvalId":item["id"],"digest":item["digest"]}),
        tx.clone(),
    )
    .await?;
    assert_eq!(theme(&*b.lock().await)?, "system");
    assert!(pending_approvals(&sync_now(b.clone(), tx.clone()).await?).is_empty());
    let received = sync_now(a.clone(), tx.clone()).await?;
    assert!(pending_approvals(&received).is_empty());
    assert_eq!(theme(&*a.lock().await)?, "system");
    for _ in 0..2 {
        assert!(pending_approvals(&sync_now(b.clone(), tx.clone()).await?).is_empty());
        assert!(pending_approvals(&sync_now(a.clone(), tx.clone()).await?).is_empty());
    }
    Ok(())
}
