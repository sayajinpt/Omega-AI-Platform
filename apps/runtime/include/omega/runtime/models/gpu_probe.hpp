#pragma once

#include <nlohmann/json.hpp>

namespace omega::runtime {

nlohmann::json list_gpu_devices();

}  // namespace omega::runtime
