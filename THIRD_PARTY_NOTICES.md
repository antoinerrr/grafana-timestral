# Licenses

The Grafana plugin and supporting service in this repository are licensed under
[Apache-2.0](LICENSE). Dependencies retain their own licenses.

The service uses Mistral AI's [Timestral inference library](https://github.com/mistralai/timestral),
also licensed under [Apache-2.0](https://github.com/mistralai/timestral/blob/main/LICENSE).

Timestral model weights are downloaded separately when the service starts. They
are not included in this repository or the container image and use Mistral AI's
**Modified MIT License**, separately from this project's Apache-2.0 license.
The model license states:

> You are not authorized to exercise any rights under this license if the global
> consolidated monthly revenue of your company (or that of your employer)
> exceeds $20 million (or its equivalent in another currency) for the preceding
> month.

That restriction also applies to derivatives, modifications, and combined works
based on the model. Affected users may request a commercial license from
[Mistral AI](mailto:sales@mistral.ai). Copies or substantial portions of the model
must retain its attribution and permission notice: **2026 - Mistral AI**.

Read the [full model license](docs/licenses/TIMESTRAL-WEIGHTS.txt), also available
on [Hugging Face](https://huggingface.co/mistralai/Timestral-5M/blob/main/LICENSE).
This is an independent integration; the project license grants no rights to
Mistral AI or Grafana trademarks.
