"""Recycle bin and backup snapshots: deleted readings can be restored, and a restore brings back old data."""
import pytest

from orbitclock import backup, store


@pytest.fixture()
def data(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA_DIR", tmp_path)
    monkeypatch.setattr(store, "_listeners", [])
    monkeypatch.setitem(backup.offsite, "enabled", False)
    store.save_settings({"launch_date": "2026-11-14"})
    for crew in ("CM-1", "CM-1", "CM-2"):
        store.add_reading(dict(crew_id=crew, mission_phase="Pre-flight", sampled_at="2026-11-13T20:00", status="Quantified",
                               saliva_pg_ml=10.0))
    return tmp_path


def test_delete_moves_to_bin_and_restore(data):
    assert store.delete_reading(2, deleted_by="Tester 1")
    assert list(store.load_readings()["reading_id"]) == [1, 3]
    b = store.load_deleted()
    assert list(b["reading_id"]) == [2] and b.iloc[0]["deleted_by"] == "Tester 1"
    assert store.restore_reading(2)
    assert sorted(store.load_readings()["reading_id"]) == [1, 2, 3]
    assert store.load_deleted().empty


def test_ids_of_deleted_readings_are_not_reused(data):
    store.delete_reading(3)
    new = store.add_reading(dict(crew_id="CM-3", mission_phase="Pre-flight", sampled_at="2026-11-13T21:00", status="Quantified"))
    assert new == 4
    assert store.restore_reading(3)
    assert sorted(store.load_readings()["reading_id"]) == [1, 2, 3, 4]


def test_purge_only_empties_the_bin(data):
    store.delete_reading(1)
    assert store.purge_reading(1)
    assert 1 not in set(store.load_readings()["reading_id"]) and store.load_deleted().empty


def test_snapshot_restore_round_trip(data):
    first = backup.snapshot("test")
    assert first and backup.snapshot("again") is None          # unchanged data -> no duplicate snapshot
    for rid in (1, 2, 3):
        store.delete_reading(rid)
        store.purge_reading(rid)
    assert store.load_readings().empty
    res = backup.restore_zip(backup.snapshot_bytes(first))
    assert res["readings"] == 3
    assert sorted(store.load_readings()["reading_id"]) == [1, 2, 3]
    assert any(s["reason"] == "before-restore" for s in backup.list_snapshots())


def test_restore_rejects_other_zips(data):
    import io
    import zipfile
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("hello.txt", "hi")
    with pytest.raises(ValueError):
        backup.restore_zip(buf.getvalue())
