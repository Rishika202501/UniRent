// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ICampusRent {
    function registerStudent(bytes32 campusId, uint40 expiry, bytes calldata sig) external;

    function withdraw() external;
}
