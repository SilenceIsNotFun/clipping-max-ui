import os
from unittest.mock import patch

from tts import generate_tts


def test_generate_tts_invokes_piper_with_expected_args(tmp_path):
    output_path = str(tmp_path / "out.wav")
    with patch("tts.subprocess.run") as mock_run:
        def fake_run(args, **kwargs):
            with open(output_path, "wb") as f:
                f.write(b"RIFF....WAVEfmt ")
            return None

        mock_run.side_effect = fake_run
        generate_tts("Halo dunia", "id_ID-voice-medium", "/app/voices", output_path)

        assert os.path.exists(output_path)
        args = mock_run.call_args[0][0]
        assert args[0] == "piper"
        assert "--model" in args
        assert "/app/voices/id_ID-voice-medium.onnx" in args
        assert "--output_file" in args
        assert output_path in args
        assert mock_run.call_args[1]["input"] == "Halo dunia"
